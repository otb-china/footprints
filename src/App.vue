<script setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { readStoredValue, StorageConflictError, storageKeys, writeStoredValues } from "./utils/toolStorage";
import { coordinates, drawMap, isMapPoint, match, readJson, root, shape } from './map.js';
import { parseBackup, serializeBackup } from './backup.js';
import { useMapZoom } from './mapZoom.js';
import { useMapDetail } from './mapDetail.js';
import { amapConfigured, getPlaceDetails, searchPlaces } from './placeSearch.js';

const storageKey = storageKeys.records;
const logoUrl = import.meta.env.BASE_URL + 'footprints-logo.svg';
const municipalities = new Set([110000, 120000, 310000, 500000]);
const levels = ['province', 'city', 'district'];
const data = shallowRef(null);
const byId = shallowRef({});
const trail = ref([]);
const map = shallowRef(null);
const mapMessage = ref('正在加载地图…');
const saved = shallowRef({});
const feedback = ref('');
class FootprintStorageError extends Error {}
let storageReadable = false;
let saving = false;
try {
  const raw = readStoredValue(storageKey);
  const stored = raw === null ? {} : JSON.parse(raw);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid footprints');
  saved.value = stored;
  storageReadable = true;
} catch {
  feedback.value = '浏览器里的足迹无法读取。';
}

const children = id => (data.value?.[id]?.children || []).filter(area => levels.includes(area.level));
const name = id => byId.value[id]?.name || '';
const canMark = id => municipalities.has(id) || ['city', 'district'].includes(byId.value[id]?.level);
const searchQuery = ref('');
const searchOpen = ref(false);
const searchInput = ref(null);
const onlinePlaces = shallowRef([]);
const searchStatus = ref('');
const resolvingPlace = ref(false);
let searchRevision = 0;
const searchLimit = 20;
const showSearchResults = computed(() => searchOpen.value && Boolean(searchQuery.value.trim()));
function indexPlace(place, areaCodes) {
  const parents = areaCodes.map(name).filter(Boolean);
  const path = [...parents, place.label];
  const shortPath = path.map(part => part.replace(/(特别行政区|自治区|自治州|地区|省|市|区|县|盟|旗)$/, ''));
  return { ...place, context: parents.join(' · '), path: path.join(''), shortPath: shortPath.join('') };
}

const searchIndex = computed(() => Object.values(byId.value).filter(area => canMark(area.adcode)).map(area =>
  indexPlace({ key: area.adcode, id: area.adcode, label: area.name }, area.acroutes)));
const searchResults = computed(() => {
  const query = searchQuery.value.replace(/\s+/g, '');
  if (!showSearchResults.value) return [];
  const areas = searchIndex.value.flatMap(place => {
    if (place.label === query) return [{ ...place, rank: 0 }];
    if (place.label.startsWith(query)) return [{ ...place, rank: 1 }];
    if (place.label.includes(query)) return [{ ...place, rank: 2 }];
    if (place.path.includes(query) || place.shortPath.includes(query)) return [{ ...place, rank: 3 }];
    return [];
  }).sort((a, b) => a.rank - b.rank);
  const seen = new Set(areas.filter(place => place.rank === 0).map(place => place.id + ':' + place.label));
  const points = onlinePlaces.value.flatMap(tip => {
    if (typeof tip?.name !== 'string' || !tip.name.trim()) return [];
    const id = Number(tip.adcode);
    const district = typeof tip.district === 'string' && tip.district.trim()
      ? tip.district.trim() : canMark(id) ? placeNames(id).join(' · ') : '';
    const address = typeof tip.address === 'string' ? tip.address.trim() : '';
    const context = address.startsWith(district) ? address : [district, address].filter(Boolean).join(' · ');
    const poiId = typeof tip.id === 'string' && tip.id.trim() ? tip.id : undefined;
    const key = poiId ? 'amap:' + poiId : 'poi:' + [tip.name, id, context, tip.point].join(':');
    const areaLabel = id + ':' + tip.name;
    if (seen.has(key) || seen.has(areaLabel)) return [];
    seen.add(key);
    return [{ key, id, poiId, label: tip.name, context, isPoint: true, point: tip.point,
      attraction: tip.attraction }];
  });
  return [...areas.filter(place => place.rank === 0), ...points, ...areas.filter(place => place.rank !== 0)];
});

watch([searchQuery, showSearchResults], ([value, visible], _, onCleanup) => {
  searchRevision++;
  onlinePlaces.value = [];
  searchStatus.value = '';
  resolvingPlace.value = false;
  if (!visible || [...value.trim()].length < 2 || searchIndex.value.some(place => place.label === value.trim())) return;
  if (!amapConfigured) {
    searchStatus.value = '高德地点搜索尚未配置，可搜索城市或区县';
    return;
  }
  searchStatus.value = '正在查询地点…';
  const controller = new AbortController();
  const timer = setTimeout(async () => {
    try {
      const places = await searchPlaces(value.trim(), controller.signal);
      if (controller.signal.aborted) return;
      onlinePlaces.value = places;
      searchStatus.value = '';
    } catch {
      if (!controller.signal.aborted) searchStatus.value = '高德地点搜索暂不可用';
    }
  }, 700);
  onCleanup(() => {
    controller.abort();
    clearTimeout(timer);
  });
});

function closeSearch(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) searchOpen.value = false;
}

function dismissSearch() {
  searchInput.value.focus();
  searchOpen.value = false;
}

const canSelectPlace = place => canMark(place.id) || Boolean(place.point || place.poiId);

async function selectSearchResult(place) {
  if (!place || resolvingPlace.value || !canSelectPlace(place)) return;
  const revision = searchRevision;
  const stillSelecting = () => revision === searchRevision && showSearchResults.value;
  let id = place.id;
  let selected = place;
  if (place.poiId && (place.attraction === undefined || !place.point || !canMark(id))) {
    resolvingPlace.value = true;
    const details = await getPlaceDetails(place.poiId).catch(() => undefined);
    if (!stillSelecting()) return;
    if (details) {
      selected = { ...place, point: details.point || place.point, attraction: details.attraction ?? place.attraction };
      if (!canMark(id)) id = Number(details.adcode);
    }
  }
  if (!canMark(id) && selected.point) {
    resolvingPlace.value = true;
    id = await areaAtPoint(selected.point).catch(() => undefined);
    if (!stillSelecting()) return;
  }
  resolvingPlace.value = false;
  if (!canMark(id)) {
    searchStatus.value = '无法识别此地点所属的城市或区县';
    return;
  }
  dismissSearch();
  searchQuery.value = '';
  openEditor(id, selected.isPoint ? selected : undefined);
}

const isLocalFootprint = ({ c, d }) => Boolean(c || d);
const areaId = computed(() => trail.value.at(-1) || root);
const mapSvg = ref(null);
const {
  view, viewport, transform, canZoomIn, canZoomOut, zoom, resetZoom,
  onWheel, onPointerDown, onPointerMove, onPointerEnd, onMapClick,
} = useMapZoom(map, areaId, mapSvg);
const areas = computed(() => children(areaId.value));
const records = computed(() => Object.entries(saved.value).filter(([, record]) => isLocalFootprint(record)).reverse());
const levelTabs = ['省级地区', '城市', '区县'];
const levelTab = ref(0);
const mapLevelTab = computed(() => {
  if (areaId.value === root) return 0;
  return areas.value[0]?.level === 'city' ? 1 : 2;
});
const scopedRecords = computed(() => areaId.value === root
  ? records.value
  : records.value.filter(([, { p, c, d }]) => [p, c, d].includes(areaId.value)));
const levelAreas = computed(() => ['p', 'c', 'd'].map(key => {
  const found = new Map();
  for (const [, record] of scopedRecords.value) {
    const id = record[key];
    if (!id) continue;
    if (!found.has(id)) found.set(id, { id, record: canMark(id) ? saved.value[id] : undefined, count: 0 });
    found.get(id).count++;
  }
  return [...found.values()];
}));
const stats = computed(() => levelAreas.value.map(list => list.length));
watch(areaId, () => {
  levelTab.value = mapLevelTab.value;
});
const lit = computed(() => new Set(records.value.flatMap(([, { p, c, d }]) => [p, c, d])));
const coverageLabel = computed(() => levelTabs[levelTab.value] + '覆盖');
const coverageAreas = computed(() => {
  if (areaId.value !== root) return areas.value;
  const level = levels[levelTab.value];
  return Object.values(byId.value).filter(area =>
    area.level === level || (level === 'city' && municipalities.has(area.adcode)));
});
const coverageTotal = computed(() => coverageAreas.value.length);
const coveredAreaCount = computed(() => coverageAreas.value.filter(area => lit.value.has(area.adcode)).length);
const coveragePercent = computed(() => coverageTotal.value ? coveredAreaCount.value / coverageTotal.value * 100 : 0);
const coveragePercentText = computed(() => {
  const value = coveragePercent.value;
  if (!value || value >= 100) return String(Math.round(value));
  return value < 10 ? value.toFixed(1) : String(Math.floor(value));
});
const coverageRemaining = computed(() => coverageTotal.value - coveredAreaCount.value);
const cityHighlights = computed(() => {
  if (areaId.value !== root) return null;
  const byProvince = new Map();
  for (const [, { p, c }] of records.value) {
    if (!p || !c || p === c) continue;
    if (!byProvince.has(p)) byProvince.set(p, new Set());
    byProvince.get(p).add(c);
  }
  return byProvince;
});
const isLit = id => areaId.value === root
  ? municipalities.has(id) && lit.value.has(id)
  : lit.value.has(id);
const isVisitedProvince = id => areaId.value === root && !municipalities.has(id) && lit.value.has(id);
const markedAttractions = computed(() => records.value.flatMap(([, { p, c, d, attractions }]) =>
  (attractions || []).filter(({ id, source }) => !source && (id.startsWith('amap:') || id.startsWith('poi:')))
    .map(attraction => ({ ...attraction, areas: [p, c, d] }))));
const markedAttractionIds = computed(() => new Set(markedAttractions.value.map(place => place.id)));
const { detail, labels, markers } = useMapDetail(
  map, view, viewport, children, isLit, areaId, id => byId.value[id]?.level, markedAttractions,
);
const hint = computed(() => {
  if (!data.value) return '';
  if (map.value && canZoomOut.value) return '拖动地图查看其他区域';
  if (areaId.value === root) return '点击省级地区，查看下一级';
  if (areas.value.some(area => area.level === 'city')) return '点击城市，查看区县';
  if (areas.value.length) return '点击区县，点亮或取消足迹';
  return '';
});

onMounted(async () => {
  if (window.location.protocol === 'file:') {
    mapMessage.value = '请用 pnpm dev 启动项目，或通过 GitHub Pages 访问。';
    return;
  }
  try {
    const catalog = await readJson('areas.json');
    byId.value = Object.fromEntries(Object.values(catalog).flatMap(node => node.children || []).map(area => [area.adcode, area]));
    data.value = catalog;
    void locate({ onEntry: true });
  } catch {
    mapMessage.value = '区划数据加载失败，请刷新重试。';
  }
});

watch([areaId, data, cityHighlights], async ([id, catalog, highlights], _, onCleanup) => {
  if (!catalog) return;
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  map.value = null;
  mapMessage.value = '正在加载地图…';
  const [geo, ...overlays] = await Promise.all([
    shape(id),
    ...Array.from(highlights || [], async ([province, cities]) => {
      const boundaries = await shape(province);
      return boundaries?.features.filter(feature => cities.has(feature.properties.adcode) && feature.geometry) || [];
    }),
  ]);
  if (cancelled) return;
  map.value = drawMap(geo, areas.value, name, overlays.flat());
  if (!map.value) {
    mapMessage.value = canMark(id)
      ? '暂无该地区的地图边界，可通过下方按钮直接点亮。'
      : areas.value.length ? '暂无该地区的地图边界。' : '暂无可点亮的下级地区。';
  }
});

function openArea(id) {
  if (!canMark(id) || (children(id).length && byId.value[id].level !== 'district')) trail.value.push(id);
  else openEditor(id);
}

function regionFor(id) {
  const area = byId.value[id];
  if (!area || !levels.includes(area.level)) return {};
  const chain = [...area.acroutes, id].filter(code => code !== root);
  const p = chain[0];
  const c = chain.find(code => byId.value[code]?.level === 'city');
  return { p, c: c || (municipalities.has(p) ? p : undefined), d: area.level === 'district' ? id : undefined };
}

function saveErrorMessage(error, fallback) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '站点存储空间不足，足迹未保存。请先备份已有足迹。';
  }
  if (error instanceof FootprintStorageError || error instanceof StorageConflictError) return error.message;
  return fallback;
}

async function persist(records) {
  if (!storageReadable) throw new FootprintStorageError('无法读取已有足迹，请刷新后重试。');
  if (saving) throw new FootprintStorageError('正在保存足迹，请稍后重试。');
  saving = true;
  try {
    await writeStoredValues({ [storageKey]: JSON.stringify(records) });
    saved.value = records;
  } finally {
    saving = false;
  }
}

const areaNote = ref('');
watch(() => [areaId.value, saved.value[areaId.value]?.note], ([, value]) => { areaNote.value = value || ''; }, { immediate: true });

async function saveNote(id, value) {
  const record = saved.value[id];
  const text = value.trim();
  if (!record || text === (record.note || '')) return;
  try {
    await persist({ ...saved.value, [id]: { ...record, note: text } });
    feedback.value = '备注已保存。';
  } catch (error) {
    feedback.value = saveErrorMessage(error, '浏览器无法保存备注，请检查存储权限。');
  }
}

function localDate() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
}

const confirmer = ref(null);
const target = ref(null);
const locating = ref(false);
const fromLocation = ref(false);
const confirmStatus = ref('');
const targetRecord = computed(() => {
  if (!target.value || target.value.remove) return undefined;
  const { id, attraction } = target.value;
  const record = saved.value[id];
  return attraction ? record?.attractions?.find(item => item.id === attraction.id) : record;
});
let locationRequest = 0;

function placeNames(id) {
  const { p, c, d } = saved.value[id] || regionFor(id);
  return [...new Set([p, c, d || id].filter(Boolean))].map(name);
}

function openEditor(id, searchPlace) {
  if (!canMark(id)) return;
  locationRequest++;
  fromLocation.value = false;
  locating.value = false;
  confirmStatus.value = '';
  const attraction = searchPlace?.attraction && isMapPoint(searchPlace.point)
    ? { id: searchPlace.key, name: searchPlace.label, point: searchPlace.point }
    : undefined;
  target.value = { id, names: placeNames(id), searchPlace, attraction };
  confirmer.value.showModal();
}

const coveredBy = id => ([key, record]) =>
  isLocalFootprint(record) && (key === String(id) || [record.p, record.c, record.d].includes(id));

function openRemove(id) {
  locationRequest++;
  fromLocation.value = false;
  locating.value = false;
  confirmStatus.value = '';
  target.value = { id, names: placeNames(id), remove: true, count: records.value.filter(coveredBy(id)).length };
  confirmer.value.showModal();
}

function openLocator() {
  fromLocation.value = true;
  confirmer.value.showModal();
  locate();
}

function closeConfirm() {
  locationRequest++;
  locating.value = false;
}

async function areaAtPoint(point) {
  const province = match(await shape(root), point, root, byId.value);
  if (!province) return undefined;
  const next = match(await shape(province), point, province, byId.value);
  if (byId.value[next]?.level !== 'city') return next || province;
  return match(await shape(next), point, next, byId.value) || next;
}

async function locate({ onEntry = false } = {}) {
  const request = ++locationRequest;
  const current = () => request === locationRequest && (onEntry || confirmer.value?.open);
  if (!onEntry) {
    locating.value = true;
    target.value = null;
    confirmStatus.value = '';
  }
  try {
    if (!navigator.geolocation) throw new Error('当前浏览器无法定位，可以在地图上点击地区来点亮。');
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, maximumAge: 60000, enableHighAccuracy: true });
    });
    const point = coordinates(position.coords.longitude, position.coords.latitude);
    const id = await areaAtPoint(point);
    if (!id) throw new Error('当前位置不在地图范围内，可以在地图上点击地区来点亮。');
    if (!current()) return;
    if (!canMark(id)) throw new Error('当前位置只定位到了省级地区，请在地图上选择城市或区县。');
    if (onEntry && (lit.value.has(id) || searchOpen.value || confirmer.value?.open || settings.value?.open || importer.value?.open)) return;
    target.value = { id, names: placeNames(id) };
    if (onEntry) {
      fromLocation.value = true;
      confirmStatus.value = '';
      confirmer.value?.showModal();
    }
  } catch (error) {
    if (!onEntry && current()) {
      if (error.code === 1) confirmStatus.value = '定位权限未开启，请在浏览器中允许定位，或在地图上点击地区来点亮。';
      else confirmStatus.value = error.code ? '暂时无法获取定位，请稍后重试。' : error.message;
    }
  } finally {
    if (!onEntry && current()) locating.value = false;
  }
}

async function saveRecords(next, message, showAttraction = false) {
  try {
    await persist(next);
    if (showAttraction) resetZoom();
    feedback.value = message;
    confirmer.value.close();
  } catch (error) {
    confirmStatus.value = saveErrorMessage(error, '浏览器无法保存足迹，请检查存储权限。');
  }
}

function confirmAction() {
  if (!target.value) {
    locate();
    return;
  }
  const { id, names, remove, count, attraction } = target.value;
  if (remove) {
    const next = Object.fromEntries(Object.entries(saved.value).filter(entry => !coveredBy(id)(entry)));
    saveRecords(next, '已删除 ' + names.join(' · ') + (count > 1 ? ' 及下级共 ' + count + ' 条足迹。' : ' 的足迹。'));
    return;
  }
  if (!canMark(id)) return;
  const next = { ...saved.value };
  if (attraction) {
    const { attractions = [], ...region } = next[id] || { ...regionFor(id), date: localDate(), note: '' };
    const removing = Boolean(targetRecord.value);
    const remaining = removing ? attractions.filter(item => item.id !== attraction.id) : [...attractions, attraction];
    next[id] = { ...region, ...(remaining.length ? { attractions: remaining } : {}) };
    saveRecords(next, (removing ? '已移除景点标记 ' : '已点亮 ') + attraction.name + '。', !removing);
    return;
  }
  if (targetRecord.value) delete next[id];
  else next[id] = { ...regionFor(id), date: localDate(), note: '' };
  saveRecords(next, (targetRecord.value ? '已取消点亮 ' : '已点亮 ') + names.join(' · ') + '。');
}

const drag = ref(null);

function swipeStart(event, id) {
  if (event.button || event.target.closest('input')) return;
  drag.value = { id, x: event.clientX, y: event.clientY, width: event.currentTarget.offsetWidth, offset: null };
}

function swipeMove(event) {
  const state = drag.value;
  if (!state) return;
  const dx = event.clientX - state.x;
  const dy = event.clientY - state.y;
  if (state.offset === null) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    if (Math.abs(dy) > Math.abs(dx) || dx > 0) {
      drag.value = null;
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  state.offset = Math.min(0, dx);
}

function swipeEnd() {
  const state = drag.value;
  drag.value = null;
  if (!state?.offset || state.offset > -Math.min(120, state.width * 0.35)) return;
  openRemove(state.id);
}

const swipeOffset = id => drag.value?.id === id && drag.value.offset !== null ? drag.value.offset + 'px' : '0';

const settings = ref(null);
const importer = ref(null);
const importMode = ref('cities');
const importSession = ref(0);
const cityList = ref('');
const importFile = ref(null);
const importStatus = ref('');
const importing = ref(false);

function openImport(mode) {
  settings.value.close();
  importMode.value = mode;
  importSession.value++;
  cityList.value = '';
  importFile.value = null;
  importStatus.value = '';
  importer.value.showModal();
}

function parseCities() {
  const names = cityList.value.trim().split(/[、，,；;\s]+/u).filter(Boolean);
  if (!names.length) throw new Error('请粘贴城市名单。');
  const cities = Object.values(byId.value).filter(area => area.level === 'city' || municipalities.has(area.adcode));
  const incoming = {};
  const unknown = [];
  for (const text of names) {
    const matches = cities.filter(area => area.name === text || area.name.replace(/市$/u, '') === text);
    if (matches.length !== 1) {
      unknown.push(text);
      continue;
    }
    const id = matches[0].adcode;
    incoming[id] = { ...regionFor(id), date: '', note: '' };
  }
  if (unknown.length) throw new Error('请核对这些城市名称：' + unknown.join('、'));
  return incoming;
}

async function importRecords() {
  if (importing.value) return;
  importing.value = true;
  try {
    let incoming;
    if (importMode.value === 'cities') incoming = parseCities();
    else {
      if (!importFile.value) throw new Error('请选择 JSON 备份文件。');
      const contents = await importFile.value.text();
      if (!importer.value.open) return;
      incoming = parseBackup(contents, regionFor);
    }
    const added = Object.keys(incoming).filter(id => !Object.hasOwn(saved.value, id)).length;
    const next = { ...incoming, ...saved.value };
    let addedAttractions = 0;
    for (const [id, record] of Object.entries(incoming)) {
      if (!saved.value[id] || !record.attractions?.length) continue;
      const current = saved.value[id].attractions || [];
      const ids = new Set(current.map(item => item.id));
      const additions = record.attractions.filter(item => !ids.has(item.id));
      if (!additions.length) continue;
      next[id] = { ...next[id], attractions: [...current, ...additions] };
      addedAttractions += additions.length;
    }
    await persist(next);
    feedback.value = '已导入 ' + added + ' 条地区足迹'
      + (addedAttractions ? '，另补充 ' + addedAttractions + ' 个景点标记' : '') + '。';
    importer.value.close();
  } catch (error) {
    if (error instanceof SyntaxError) importStatus.value = '文件不是有效的 JSON。';
    else if (error instanceof DOMException) importStatus.value = saveErrorMessage(error, '无法读取文件或保存足迹，请检查浏览器权限。');
    else importStatus.value = error.message;
  } finally {
    importing.value = false;
  }
}

function exportRecords() {
  const blob = new Blob([serializeBackup(saved.value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'footprints-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback.value = '已导出 ' + Object.keys(saved.value).length + ' 条足迹。';
  settings.value.close();
}
</script>

<template>
  <header>
    <h1 class="brand">
      <img :src="logoUrl" width="32" height="32" alt="">
      <span>我的足迹<small>点亮走过的城市与区县</small></span>
    </h1>
    <button type="button" class="settings-toggle" aria-label="设置" title="设置"
      aria-haspopup="dialog" @click="settings.showModal()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 3h4l.6 2.5 1.7 1 2.5-.7 2 3.5-1.9 1.8v1.8l1.9 1.8-2 3.5-2.5-.7-1.7 1-.6 2.5h-4l-.6-2.5-1.7-1-2.5.7-2-3.5 1.9-1.8v-1.8L3.2 9.3l2-3.5 2.5.7 1.7-1z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  </header>
  <main>
    <div class="layout">
      <section class="panel">
        <div class="bar map-bar">
          <nav aria-label="地图层级">
            <template v-for="(id, index) in [root, ...trail]" :key="id">
              <span v-if="index" class="crumb-separator" aria-hidden="true">/</span>
              <span v-if="id === areaId" aria-current="location">{{ id === root ? '全国' : name(id) }}</span>
              <button v-else type="button" @click="trail = trail.slice(0, index)">
                {{ id === root ? '全国' : name(id) }}
              </button>
            </template>
          </nav>
          <form v-if="areaId === root" class="place-search" role="search" aria-label="搜索地点"
            @submit.prevent="selectSearchResult(searchResults[0])"
            @focusout="closeSearch" @keydown.esc.prevent="dismissSearch">
            <div class="place-search-field">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="5.5" />
                <path d="m15 15 4 4" />
              </svg>
              <input ref="searchInput" v-model="searchQuery" type="search" aria-label="搜索地点或地区"
                placeholder="搜索地点或地区" :disabled="!data" autocomplete="off"
                @focus="searchOpen = true" @input="searchOpen = true">
              <button v-if="searchQuery" type="button" class="place-search-clear" aria-label="清除搜索"
                @mousedown.prevent @click="searchQuery = ''; searchInput.focus()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                  stroke-linecap="round" aria-hidden="true">
                  <path d="m8 8 8 8M16 8l-8 8" />
                </svg>
              </button>
            </div>
            <div v-if="showSearchResults" class="place-search-results">
              <ul v-if="searchResults.length" aria-label="地点搜索结果">
                <li v-for="place in searchResults.slice(0, searchLimit)" :key="place.key">
                  <button type="button" aria-haspopup="dialog" :disabled="!canSelectPlace(place)"
                    @mousedown.prevent @click="selectSearchResult(place)">
                    <span class="place-search-icon" :class="{ point: place.isPoint }" aria-hidden="true">
                      <svg v-if="place.isPoint" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
                        <circle cx="12" cy="10" r="2.3" />
                      </svg>
                      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m3.5 6.5 5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5Z" />
                        <path d="M9 4v13.5M15 6.5V20" />
                      </svg>
                    </span>
                    <span class="place-search-name">
                      <strong>{{ place.label }}</strong>
                      <small v-if="place.context" :title="place.context">{{ place.context }}</small>
                    </span>
                    <small v-if="!canSelectPlace(place)" class="place-search-tag">暂无法点亮</small>
                    <small v-else-if="place.attraction && markedAttractionIds.has(place.key)" class="place-search-tag lit">景点已点亮</small>
                    <small v-else-if="saved[place.id]" class="place-search-tag lit">地区已点亮</small>
                  </button>
                </li>
              </ul>
              <p v-if="resolvingPlace || searchStatus || !searchResults.length" role="status"
                class="place-search-status">
                {{ resolvingPlace ? '正在识别所属地区…' : searchStatus || '没有找到匹配的地点' }}
              </p>
              <p v-if="searchResults.length > searchLimit" class="place-search-status">匹配较多，可输入更完整的地点名称</p>
            </div>
          </form>
          <div v-if="areaId === root" class="map-bar-actions">
            <button type="button" class="add-footprint" aria-label="点亮当前位置" title="点亮当前位置"
              :disabled="!data" @click="openLocator">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
                <circle cx="12" cy="10" r="2.3" />
              </svg>
            </button>
          </div>
        </div>
        <div id="map" aria-label="行政区地图">
          <svg v-if="map" ref="mapSvg" :class="{ 'is-zoomed': canZoomOut }" :viewBox="map.viewBox" @wheel.prevent="onWheel"
            @pointerdown="onPointerDown" @pointermove="onPointerMove"
            @pointerup="onPointerEnd" @pointercancel="onPointerEnd" @lostpointercapture="onPointerEnd"
            @click.capture="onMapClick">
            <g :transform="transform">
              <template v-for="item in map.paths" :key="item.adcode">
                <path v-if="item.outline" class="outline" :d="item.path" fill-rule="evenodd" />
                <path v-else :class="{ lit: isLit(item.adcode), visited: isVisitedProvince(item.adcode) }" :d="item.path" fill-rule="evenodd"
                  tabindex="0" role="button" :aria-label="name(item.adcode)" @click="openArea(item.adcode)"
                  @keydown.enter.prevent="openArea(item.adcode)" @keydown.space.prevent="openArea(item.adcode)">
                  <title>{{ name(item.adcode) }}</title>
                </path>
              </template>
              <path v-for="item in map.overlays" :key="'city-' + item.adcode" class="lit city-overlay"
                :d="item.path" fill-rule="evenodd" />
              <path v-for="item in detail.cities" :key="'detail-' + item.adcode" class="map-detail"
                :d="item.path" fill-rule="evenodd" />
              <path v-for="item in detail.districts" :key="'district-' + item.adcode" class="map-detail district-detail"
                :d="item.path" fill-rule="evenodd" />
            </g>
            <text v-for="label in labels" :key="label.adcode" :class="{ 'lit-label': label.highlighted }" :x="label.x" :y="label.y">{{ label.text }}</text>
            <g v-for="marker in markers" :key="marker.id" class="attraction-marker" role="img" :aria-label="marker.name">
              <title>{{ marker.name }}</title>
              <path class="attraction-pin" :transform="'translate(' + marker.x + ' ' + marker.y + ')'"
                d="M0 0C-2-3-7-7-7-12a7 7 0 1 1 14 0c0 5-5 9-7 12Z" />
              <circle :cx="marker.x" :cy="marker.y - 12" r="2.5" />
              <text v-if="marker.label" :x="marker.labelBox.x" :y="marker.labelBox.y">{{ marker.label }}</text>
            </g>
          </svg>
          <div v-if="map" class="legend">
            <span v-if="areaId === root" class="legend-item visited">到过的省份</span>
            <span class="legend-item">{{ areaId === root ? '点亮城市' : '已点亮' }}</span>
          </div>
          <span v-if="!map" class="map-message" :class="{ loading: mapMessage.startsWith('正在加载') }">{{ mapMessage }}</span>
          <div v-if="map" class="map-controls" role="group" aria-label="地图缩放">
            <button type="button" aria-label="放大地图" title="放大" :disabled="!canZoomIn" @click="zoom(1)">＋</button>
            <button type="button" aria-label="缩小地图" title="缩小" :disabled="!canZoomOut" @click="zoom(-1)">−</button>
            <button type="button" aria-label="恢复地图全览" title="复位" :disabled="!canZoomOut" @click="resetZoom">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </svg>
            </button>
          </div>
        </div>
        <div class="bar foot">
          <div class="area-status">
            <strong v-if="areaId !== root">
              {{ name(areaId) }}<span v-if="canMark(areaId) && saved[areaId]" class="lit-badge">已点亮</span>
              <span v-else-if="!canMark(areaId) && lit.has(areaId)" class="lit-badge">已到访</span>
            </strong>
            <span class="hint">{{ canMark(areaId) && saved[areaId]?.date ? '到访于 ' + saved[areaId].date : hint }}</span>
          </div>
          <template v-if="canMark(areaId)">
            <button v-if="saved[areaId]" type="button" class="map-mark danger" @click="openEditor(areaId)">取消点亮</button>
            <button v-else type="button" class="map-mark" @click="openEditor(areaId)">点亮</button>
          </template>
          <input v-if="saved[areaId] && canMark(areaId)" v-model="areaNote" class="area-note" type="text" maxlength="300"
            placeholder="写点备注，比如和谁一起、印象最深的事" aria-label="备注" enterkeyhint="done"
            @change="saveNote(areaId, areaNote)" @keydown.enter="$event.target.blur()">
        </div>
      </section>
      <aside class="panel side">
        <h2 v-if="areaId === root">足迹概览</h2>
        <div v-if="areaId === root" class="stats" role="tablist" aria-label="按层级查看足迹">
          <button v-for="(label, index) in levelTabs" :key="label" type="button" role="tab"
            :class="{ active: levelTab === index }" :aria-selected="levelTab === index" @click="levelTab = index">
            <strong>{{ stats[index] }}</strong>{{ label }}
          </button>
        </div>
        <div v-if="coverageTotal" class="progress">
          <div class="progress-head">
            <span class="progress-label">{{ coverageLabel }}</span>
            <span class="progress-count"><strong>{{ coveredAreaCount }}</strong> / {{ coverageTotal }}</span>
          </div>
          <div class="progress-main">
            <strong class="progress-percent">{{ coveragePercentText }}<small>%</small></strong>
            <span class="progress-remain">{{ coverageRemaining ? '还有 ' + coverageRemaining + ' 个待点亮' : '已全部点亮' }}</span>
          </div>
          <div class="progress-track" role="progressbar" :aria-label="coverageLabel" :aria-valuenow="coveredAreaCount"
            aria-valuemin="0" :aria-valuemax="coverageTotal" :aria-valuetext="coveredAreaCount + ' / ' + coverageTotal">
            <span v-if="coveredAreaCount" :class="{ done: !coverageRemaining }"
              :style="{ width: 'max(10px, ' + coveragePercent + '%)' }"></span>
          </div>
        </div>
        <h2 class="records-title">
          {{ levelTab === 0 ? '到访的省级地区' : (areaId === root ? '' : name(areaId) + ' · ') + '点亮的' + levelTabs[levelTab] }}
          <span v-if="levelAreas[levelTab].length" class="count">{{ levelAreas[levelTab].length }}</span>
        </h2>
        <p v-if="feedback" role="status">{{ feedback }}</p>
        <div id="records">
          <p v-if="!levelAreas[levelTab].length" class="empty">
            {{ levelTab === 0 ? '点亮城市或区县后，会自动计入所属省级地区。'
              : records.length ? '这里还没有点亮的' + levelTabs[levelTab] + '，点击地图来点亮。'
              : '还没有足迹。点击地图探索，或点亮当前位置。' }}
          </p>
          <div v-for="item in levelAreas[levelTab]" :key="item.id" class="swipe">
            <span class="swipe-delete" aria-hidden="true">删除</span>
            <div class="entry" :class="{ dragging: drag?.id === item.id && drag.offset !== null }"
              :style="{ transform: 'translateX(' + swipeOffset(item.id) + ')' }"
              @pointerdown="swipeStart($event, item.id)" @pointermove="swipeMove" @pointerup="swipeEnd" @pointercancel="drag = null">
              <span class="entry-title">{{ areaId === root ? placeNames(item.id).join(' · ') : name(item.id) }}</span>
              <template v-if="item.record">
                <small v-if="item.record.date">到访于 {{ item.record.date }}</small>
                <input v-if="levelTab !== 0 && canMark(item.id)" :key="item.record.note" class="entry-note" type="text" maxlength="300" :value="item.record.note"
                  placeholder="添加备注" aria-label="备注" enterkeyhint="done"
                  @change="saveNote(item.id, $event.target.value)" @keydown.enter="$event.target.blur()">
              </template>
              <small v-else>{{ item.count }} 条下级足迹</small>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </main>

  <dialog ref="settings" class="sheet" aria-labelledby="settings-title" closedby="any">
    <div class="dialog-head">
      <div>
        <h2 id="settings-title">更多操作</h2>
        <p>导入或导出你的足迹数据</p>
      </div>
      <button type="button" class="dialog-close" aria-label="关闭" autofocus @click="settings.close()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <div class="settings-grid">
      <button type="button" class="settings-item" :disabled="!data" @click="openImport('cities')">
        <span class="settings-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
            <circle cx="12" cy="10" r="2.3" />
          </svg>
        </span>
        <span>
          <strong>批量导入城市</strong>
          <em>粘贴城市名单，一次点亮多个城市</em>
        </span>
      </button>
      <button type="button" class="settings-item" :disabled="!data" @click="openImport('backup')">
        <span class="settings-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
        <span>
          <strong>导入备份</strong>
          <em>将备份与本地足迹合并</em>
        </span>
      </button>
      <button type="button" class="settings-item" @click="exportRecords">
        <span class="settings-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
        <span>
          <strong>导出备份</strong>
          <em>下载 {{ records.length }} 条足迹的备份文件</em>
        </span>
      </button>
    </div>
  </dialog>

  <dialog ref="confirmer" class="confirm-dialog" aria-labelledby="confirm-title" closedby="any" @close="closeConfirm">
    <span class="confirm-icon" :class="{ locating, failed: (!locating && !target) || target?.remove, lit: targetRecord }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
        <circle cx="12" cy="10" r="2.3" />
      </svg>
    </span>
    <h2 id="confirm-title" tabindex="-1" autofocus>
      {{ locating ? '正在定位…' : !target ? '定位失败' : target.remove ? '删除足迹？'
        : target.attraction ? (targetRecord ? '移除景点标记？' : '点亮这个景点？')
        : targetRecord ? '取消点亮？' : fromLocation ? '点亮当前位置？' : target.searchPlace ? '点亮所属地区？' : '点亮这里？' }}
    </h2>
    <p v-if="target?.searchPlace">
      {{ target.searchPlace.label }}{{ target.searchPlace.context ? ' · ' + target.searchPlace.context : '' }}
    </p>
    <p v-if="target" class="confirm-place">{{ target.names.join(' · ') }}</p>
    <p class="confirm-text" role="status">
      {{ locating ? '正在获取你所在的地区，请稍候'
        : confirmStatus || (target?.remove
          ? (target.count > 1 ? '将删除这里及下级地区共 ' + target.count + ' 条足迹，日期和备注会一并删除' : '这条足迹的日期和备注会一并删除')
          : target?.attraction
          ? (targetRecord ? '将从地图上移除此景点的图钉' : '地图将标记这个景点，并点亮所属地区')
          : targetRecord
          ? '取消后，这里的到访日期和备注会一并删除'

          : '到访日期记为今天') }}
    </p>
    <div class="confirm-actions">
      <button type="button" class="ghost-button" @click="confirmer.close()">{{ targetRecord || target?.remove ? '保留' : '取消' }}</button>
      <button v-if="!locating && (target || fromLocation)" type="button" class="submit-button"
        :class="{ danger: targetRecord || target?.remove }" @click="confirmAction">
        {{ !target ? '重试' : target.remove ? '删除' : targetRecord ? (target.attraction ? '移除标记' : '取消点亮') : '点亮' }}
      </button>
    </div>
  </dialog>

  <dialog ref="importer" class="sheet" aria-labelledby="importer-title" @cancel="importing && $event.preventDefault()">
    <form @submit.prevent="importRecords">
      <div class="dialog-head">
        <div>
          <h2 id="importer-title">{{ importMode === 'cities' ? '批量点亮城市' : '导入足迹备份' }}</h2>
          <p>导入会与本地足迹合并，已有记录保留本地日期和备注。</p>
        </div>
        <button type="button" class="dialog-close" aria-label="关闭" :disabled="importing" @click="importer.close()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div v-if="records.length" class="summary-card">
        <strong>当前数据</strong>
        <span>{{ records.length }} 条本地足迹</span>
      </div>
      <label v-if="importMode === 'cities'" class="field-row">
        <span>城市名单<em>可用顿号、逗号或换行分隔</em></span>
        <textarea v-model="cityList" rows="5" placeholder="北京市、杭州市、广州市" required></textarea>
      </label>
      <label v-else class="file-upload-card" :class="{ disabled: importing }">
        <input :key="importSession" class="file-input" type="file" accept=".json,application/json"
          :disabled="importing" @change="importFile = $event.target.files[0]; importStatus = ''">
        <span class="settings-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
        <span>
          <strong>{{ importFile?.name || '选择备份文件' }}</strong>
          <em>{{ importFile ? '文件已选择，点击下方按钮导入' : '支持本项目导出的 .json 备份文件' }}</em>
        </span>
      </label>
      <p v-if="importStatus" class="error" role="alert">{{ importStatus }}</p>
      <button class="submit-button" type="submit" :disabled="importing || (importMode === 'backup' && !importFile)">
        {{ importing ? '正在导入…' : importMode === 'cities' ? '导入并点亮' : '合并导入' }}
      </button>
    </form>
  </dialog>
</template>
