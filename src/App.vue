<script setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { coordinates, drawMap, match, readJson, root, shape } from './map.js';
import { parseBackup, serializeBackup } from './backup.js';
import { useMapZoom } from './mapZoom.js';
import { useMapDetail } from './mapDetail.js';

const storageKey = 'footprints-v1';
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
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) saved.value = stored;
} catch {
  feedback.value = '浏览器里的足迹无法读取。';
}

const children = id => (data.value?.[id]?.children || []).filter(area => levels.includes(area.level));
const name = id => byId.value[id]?.name || '';
const areaId = computed(() => trail.value.at(-1) || root);
const mapSvg = ref(null);
const {
  view, viewport, transform, canZoomIn, canZoomOut, zoom, resetZoom,
  onWheel, onPointerDown, onPointerMove, onPointerEnd, onMapClick,
} = useMapZoom(map, areaId, mapSvg);
const areas = computed(() => children(areaId.value));
const records = computed(() => Object.entries(saved.value).reverse());
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
    if (!found.has(id)) found.set(id, { id, record: saved.value[id], count: 0 });
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
const canNote = id => municipalities.has(id) || ['city', 'district'].includes(byId.value[id]?.level);
const { detail, labels, markers, attractionData } = useMapDetail(map, view, viewport, children, isLit, areaId, id => byId.value[id]?.level);
const hint = computed(() => {
  if (!data.value) return '';
  if (map.value && canZoomOut.value) return '拖动地图查看其他区域';
  if (areaId.value === root) return '点击省级地区，查看下一级';
  if (areas.value.some(area => area.level === 'city')) return '点击城市，查看区县';
  return '点击区县，点亮或取消足迹';
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
  if (!map.value) mapMessage.value = '暂无该地区的地图边界，可通过下方按钮直接点亮。';
});

function openArea(id) {
  if (children(id).length && byId.value[id].level !== 'district') trail.value.push(id);
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

function persist(records) {
  localStorage.setItem(storageKey, JSON.stringify(records));
  saved.value = records;
}

const areaNote = ref('');
watch(() => [areaId.value, saved.value[areaId.value]?.note], ([, value]) => { areaNote.value = value || ''; }, { immediate: true });

function saveNote(id, value) {
  const record = saved.value[id];
  const text = value.trim();
  if (!record || text === (record.note || '')) return;
  try {
    persist({ ...saved.value, [id]: { ...record, note: text } });
    feedback.value = '备注已保存。';
  } catch {
    feedback.value = '浏览器无法保存备注，请检查存储权限。';
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
const targetRecord = computed(() => target.value && !target.value.remove && saved.value[target.value.id]);
let locationRequest = 0;

function placeNames(id) {
  const { p, c, d } = saved.value[id] || regionFor(id);
  return [...new Set([p, c, d || id].filter(Boolean))].map(name);
}

function openEditor(id) {
  locationRequest++;
  fromLocation.value = false;
  locating.value = false;
  confirmStatus.value = '';
  target.value = { id, names: placeNames(id) };
  confirmer.value.showModal();
}

const coveredBy = id => ([key, { p, c, d }]) => key === String(id) || [p, c, d].includes(id);

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
    const p = match(await shape(root), point, root, byId.value);
    if (!p) throw new Error('当前位置不在地图范围内，可以在地图上点击地区来点亮。');
    const next = match(await shape(p), point, p, byId.value);
    const c = byId.value[next]?.level === 'city' ? next : undefined;
    const d = c ? match(await shape(c), point, c, byId.value) : next;
    const id = d || c || p;
    if (!current()) return;
    if (onEntry && (lit.value.has(id) || confirmer.value?.open || settings.value?.open || importer.value?.open)) return;
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

function saveRecords(next, message) {
  try {
    persist(next);
    feedback.value = message;
    confirmer.value.close();
  } catch {
    confirmStatus.value = '浏览器无法保存足迹，请检查存储权限。';
  }
}

function confirmAction() {
  if (!target.value) {
    locate();
    return;
  }
  const { id, names, remove, count } = target.value;
  if (remove) {
    const next = Object.fromEntries(Object.entries(saved.value).filter(entry => !coveredBy(id)(entry)));
    saveRecords(next, '已删除 ' + names.join(' · ') + (count > 1 ? ' 及下级共 ' + count + ' 条足迹。' : ' 的足迹。'));
    return;
  }
  const next = { ...saved.value };
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
    persist({ ...incoming, ...saved.value });
    feedback.value = '已导入 ' + added + ' 条足迹，跳过 ' + (Object.keys(incoming).length - added) + ' 条已有记录。';
    importer.value.close();
  } catch (error) {
    if (error instanceof SyntaxError) importStatus.value = '文件不是有效的 JSON。';
    else if (error instanceof DOMException) importStatus.value = '无法读取文件或保存足迹，请检查浏览器权限。';
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
  feedback.value = '已导出 ' + records.value.length + ' 条足迹。';
  settings.value.close();
}
</script>

<template>
  <header>
    <h1 class="brand">
      <img :src="logoUrl" width="32" height="32" alt="">
      <span>我的足迹<small>点亮走过的省、市与区县</small></span>
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
          <svg v-if="map" ref="mapSvg" :viewBox="map.viewBox" @wheel.prevent="onWheel"
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
              {{ name(areaId) }}<span v-if="saved[areaId]" class="lit-badge">已点亮</span>
            </strong>
            <span class="hint">{{ saved[areaId]?.date ? '到访于 ' + saved[areaId].date : hint }}</span>
          </div>
          <template v-if="areaId !== root">
            <button v-if="saved[areaId]" type="button" class="map-mark danger" @click="openEditor(areaId)">取消点亮</button>
            <button v-else type="button" class="map-mark" @click="openEditor(areaId)">点亮</button>
          </template>
          <input v-if="saved[areaId] && canNote(areaId)" v-model="areaNote" class="area-note" type="text" maxlength="300"
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
          <div class="progress-text">
            <span>{{ coverageLabel }}</span>
            <span><strong>{{ coveredAreaCount }}</strong> / {{ coverageTotal }}</span>
            <em>{{ Math.round(coveragePercent) }}%</em>
          </div>
          <div class="progress-track" role="progressbar" :aria-label="coverageLabel" :aria-valuenow="coveredAreaCount"
            aria-valuemin="0" :aria-valuemax="coverageTotal">
            <span :style="{ width: coveragePercent + '%' }"></span>
          </div>
        </div>
        <h2 class="records-title">
          {{ (areaId === root ? '' : name(areaId) + ' · ') + '点亮的' + levelTabs[levelTab] }}
          <span v-if="levelAreas[levelTab].length" class="count">{{ levelAreas[levelTab].length }}</span>
        </h2>
        <p v-if="feedback" role="status">{{ feedback }}</p>
        <div id="records">
          <p v-if="!levelAreas[levelTab].length" class="empty">
            {{ records.length ? '这里还没有点亮的' + levelTabs[levelTab] + '，点击地图来点亮。' : '还没有足迹。点击地图探索，或点亮当前位置。' }}
          </p>
          <div v-for="item in levelAreas[levelTab]" :key="item.id" class="swipe">
            <span class="swipe-delete" aria-hidden="true">删除</span>
            <div class="entry" :class="{ dragging: drag?.id === item.id && drag.offset !== null }"
              :style="{ transform: 'translateX(' + swipeOffset(item.id) + ')' }"
              @pointerdown="swipeStart($event, item.id)" @pointermove="swipeMove" @pointerup="swipeEnd" @pointercancel="drag = null">
              <span class="entry-title">{{ areaId === root ? placeNames(item.id).join(' · ') : name(item.id) }}</span>
              <template v-if="item.record">
                <small v-if="item.record.date">到访于 {{ item.record.date }}</small>
                <input v-if="levelTab !== 0 && canNote(item.id)" :key="item.record.note" class="entry-note" type="text" maxlength="300" :value="item.record.note"
                  placeholder="添加备注" aria-label="备注" enterkeyhint="done"
                  @change="saveNote(item.id, $event.target.value)" @keydown.enter="$event.target.blur()">
              </template>
              <small v-else>由 {{ item.count }} 条下级足迹点亮</small>
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
    <p v-if="attractionData" class="data-credit">
      景点数据来自 <a :href="attractionData.source" target="_blank" rel="noopener">Lore Routes</a>
      · <a :href="attractionData.licenseUrl" target="_blank" rel="noopener">{{ attractionData.license }}</a>
    </p>
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
      {{ locating ? '正在定位…' : !target ? '定位失败' : target.remove ? '删除足迹？' : targetRecord ? '取消点亮？' : fromLocation ? '点亮当前位置？' : '点亮这里？' }}
    </h2>
    <p v-if="target" class="confirm-place">{{ target.names.join(' · ') }}</p>
    <p class="confirm-text" role="status">
      {{ locating ? '正在获取你所在的地区，请稍候'
        : confirmStatus || (target?.remove
          ? (target.count > 1 ? '将删除这里及下级地区共 ' + target.count + ' 条足迹，日期和备注会一并删除' : '这条足迹的日期和备注会一并删除')
          : targetRecord
          ? '取消后，这里的到访日期和备注会一并删除'

          : '到访日期记为今天') }}
    </p>
    <div class="confirm-actions">
      <button type="button" class="ghost-button" @click="confirmer.close()">{{ targetRecord || target?.remove ? '保留' : '取消' }}</button>
      <button v-if="!locating && (target || fromLocation)" type="button" class="submit-button"
        :class="{ danger: targetRecord || target?.remove }" @click="confirmAction">
        {{ !target ? '重试' : target.remove ? '删除' : targetRecord ? '取消点亮' : '点亮' }}
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
