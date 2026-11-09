<script setup>
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { coordinates, drawMap, match, readJson, root, shape } from './map.js';
import { parseBackup, serializeBackup } from './backup.js';
import { useMapZoom } from './mapZoom.js';
import { useMapDetail } from './mapDetail.js';

const storageKey = 'footprints-v1';
const municipalities = new Set([110000, 120000, 310000, 500000]);
const levels = new Set(['province', 'city', 'district']);
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

const children = id => (data.value?.[id]?.children || []).filter(area => levels.has(area.level));
const name = id => byId.value[id]?.name || '';
const areaId = computed(() => trail.value.at(-1) || root);
const {
  view, transform, canZoomIn, canZoomOut, zoom, resetZoom,
  onWheel, onPointerDown, onPointerMove, onPointerEnd, onMapClick,
} = useMapZoom(map, areaId);
const areas = computed(() => children(areaId.value));
const provinces = computed(() => children(root));
const records = computed(() => Object.entries(saved.value).reverse());
const stats = computed(() => ['p', 'c', 'd'].map(key =>
  new Set(records.value.map(([, record]) => record[key]).filter(Boolean)).size
));
const lit = computed(() => new Set(records.value.flatMap(([, { p, c, d }]) => [p, c, d])));
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
const { detail, labels } = useMapDetail(map, view, children, isLit, areaId, id => byId.value[id]?.level);
const hint = computed(() => {
  if (!data.value) return '';
  if (areaId.value === root) return '点击省级地区，查看下一级';
  if (areas.value.some(area => area.level === 'city')) return '点击城市，查看区县';
  return '点击区县，新增或编辑足迹';
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
  if (!map.value) mapMessage.value = '暂无该地区的地图边界，可在下方选择地区。';
});

function openArea(id) {
  if (children(id).length && byId.value[id].level !== 'district') trail.value.push(id);
  else openEditor(id);
}

function regionFor(id) {
  const area = byId.value[id];
  if (!area || !levels.has(area.level)) return {};
  const chain = [...area.acroutes, id].filter(code => code !== root);
  const p = chain[0];
  const c = chain.find(code => byId.value[code]?.level === 'city');
  return { p, c: c || (municipalities.has(p) ? p : undefined), d: area.level === 'district' ? id : undefined };
}

function persist(records) {
  localStorage.setItem(storageKey, JSON.stringify(records));
  saved.value = records;
}

const editor = ref(null);
const editing = ref(null);
const draft = reactive({ p: '', c: '', d: '', date: '', note: '' });
const cities = computed(() => children(draft.p).filter(area => area.level === 'city'));
const districts = computed(() => children(draft.c || draft.p).filter(area => area.level === 'district'));
const editorStatus = ref('');
const locating = ref(false);
let locationRequest = 0;

function openEditor(id) {
  const record = saved.value[id];
  const { p, c, d } = record || regionFor(id);
  editing.value = record ? id : null;
  const today = new Date();
  const localDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  Object.assign(draft, {
    p: p || '',
    c: c === p ? '' : c || '',
    d: d || '',
    date: record ? record.date || '' : localDate,
    note: record?.note || '',
  });
  editorStatus.value = '';
  editor.value.showModal();
}

function closeEditor() {
  locationRequest++;
  locating.value = false;
}

function saveFootprint() {
  const id = draft.d || draft.c || draft.p;
  if (!id) return;
  if (saved.value[id] && id !== editing.value) {
    editorStatus.value = '这里已经点亮，请从点亮记录中编辑原记录。';
    return;
  }
  const next = { ...saved.value };
  if (editing.value) delete next[editing.value];
  next[id] = { ...regionFor(id), date: draft.date, note: draft.note.trim() };
  finishEdit(next, '足迹已保存。');
}

function removeFootprint() {
  const next = { ...saved.value };
  delete next[editing.value];
  finishEdit(next, '已取消点亮。');
}

function finishEdit(next, message) {
  try {
    persist(next);
    feedback.value = message;
    editor.value.close();
  } catch {
    editorStatus.value = '浏览器无法保存足迹，请检查存储权限。';
  }
}

async function locate() {
  const request = ++locationRequest;
  const current = () => request === locationRequest && editor.value.open;
  locating.value = true;
  editorStatus.value = '正在获取定位…';
  try {
    if (!navigator.geolocation) throw new Error('当前浏览器无法定位，请手动选择。');
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, maximumAge: 60000, enableHighAccuracy: true });
    });
    const point = coordinates(position.coords.longitude, position.coords.latitude);
    const p = match(await shape(root), point, root, byId.value);
    if (!p) throw new Error('当前位置未匹配到地图区域，请手动选择。');
    const next = match(await shape(p), point, p, byId.value);
    const c = byId.value[next]?.level === 'city' ? next : undefined;
    const d = c ? match(await shape(c), point, c, byId.value) : next;
    if (current()) {
      Object.assign(draft, { p, c: c || '', d: d || '' });
      editorStatus.value = '已匹配 ' + [p, c, d].filter(Boolean).map(name).join(' · ') + '，确认后保存。';
    }
  } catch (error) {
    if (current()) {
      if (error.code === 1) editorStatus.value = '定位权限未开启，可以手动选择。';
      else editorStatus.value = error.code ? '暂时无法获取定位，请重试或手动选择。' : error.message;
    }
  } finally {
    if (current()) locating.value = false;
  }
}

const importer = ref(null);
const importMode = ref('cities');
const importSession = ref(0);
const cityList = ref('');
const importFile = ref(null);
const importStatus = ref('');
const importing = ref(false);

function openImport(mode) {
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
}
</script>

<template>
  <header>
    <h1 class="brand"><span aria-hidden="true">✦</span>我的足迹</h1>
    <button class="primary" :disabled="!data" @click="openEditor()">＋ 新增足迹</button>
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
          <span class="legend">已点亮</span>
        </div>
        <div id="map" aria-label="行政区地图">
          <svg v-if="map" :viewBox="map.viewBox" @wheel.prevent="onWheel"
            @pointerdown="onPointerDown" @pointermove="onPointerMove"
            @pointerup="onPointerEnd" @pointercancel="onPointerEnd" @lostpointercapture="onPointerEnd"
            @click.capture="onMapClick">
            <g :transform="transform">
              <template v-for="item in map.paths" :key="item.adcode">
                <path v-if="item.outline" class="outline" :d="item.path" fill-rule="evenodd" />
                <path v-else :class="{ lit: isLit(item.adcode) }" :d="item.path" fill-rule="evenodd"
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
          </svg>
          <div v-if="map" class="map-controls" role="group" aria-label="地图缩放">
            <button type="button" aria-label="放大地图" :disabled="!canZoomIn" @click="zoom(1)">＋</button>
            <button type="button" aria-label="缩小地图" :disabled="!canZoomOut" @click="zoom(-1)">−</button>
            <button type="button" aria-label="恢复地图全览" :disabled="!canZoomOut" @click="resetZoom">复位</button>
          </div>
          <span v-else>{{ mapMessage }}</span>
        </div>
        <div class="bar foot">
          <span>{{ hint }}</span>
          <button v-if="areaId !== root" type="button" class="map-mark" @click="openEditor(areaId)">点亮这里</button>
        </div>
        <details v-if="areas.length" class="region-list">
          <summary>地区列表</summary>
          <div id="regions">
            <button v-for="area in areas" :key="area.adcode" :class="{ lit: isLit(area.adcode) }" @click="openArea(area.adcode)">
              {{ area.name }}
            </button>
          </div>
        </details>
      </section>
      <aside class="panel side">
        <h2>足迹概览</h2>
        <div class="stats">
          <div v-for="(label, index) in ['省级地区', '城市', '区县']" :key="label"><strong>{{ stats[index] }}</strong>{{ label }}</div>
        </div>
        <h2>点亮记录</h2>
        <div class="record-actions">
          <button :disabled="!data" @click="openImport('cities')">批量导入城市</button>
          <button :disabled="!data" @click="openImport('backup')">导入备份</button>
          <button @click="exportRecords">导出备份</button>
        </div>
        <p v-if="feedback" role="status">{{ feedback }}</p>
        <div id="records">
          <p v-if="!records.length">还没有足迹。点击地图探索，或新增第一条记录。</p>
          <button v-for="[id, record] in records" :key="id" class="entry" :disabled="!data" @click="openEditor(Number(id))">
            {{ [...new Set([record.p, record.c, record.d].filter(Boolean))].map(name).join(' · ') }}
            <small>{{ [record.date, record.note].filter(Boolean).join(' · ') || '编辑足迹' }}</small>
          </button>
        </div>
      </aside>
    </div>
  </main>

  <dialog ref="editor" class="footprint-editor" aria-labelledby="editor-title" @close="closeEditor">
    <form @submit.prevent="saveFootprint">
      <div class="bar modalhead">
        <h2 id="editor-title">{{ editing ? '编辑足迹' : '新增足迹' }}</h2>
        <button type="button" class="editor-close" aria-label="关闭" @click="editor.close()">×</button>
      </div>
      <button class="locate" type="button" :disabled="locating" @click="locate">使用当前位置</button>
      <p id="status" role="status">{{ editorStatus }}</p>
      <div class="editor-fields">
        <label>省份
          <select v-model="draft.p" required @change="draft.c = draft.d = ''">
            <option value="">请选择省份</option>
            <option v-for="area in provinces" :key="area.adcode" :value="area.adcode">{{ area.name }}</option>
          </select>
        </label>
        <label>城市
          <select v-model="draft.c" :disabled="!cities.length" @change="draft.d = ''">
            <option value="">选择城市</option>
            <option v-for="area in cities" :key="area.adcode" :value="area.adcode">{{ area.name }}</option>
          </select>
        </label>
        <label>区县
          <select v-model="draft.d" :disabled="!districts.length">
            <option value="">选择区县</option>
            <option v-for="area in districts" :key="area.adcode" :value="area.adcode">{{ area.name }}</option>
          </select>
        </label>
        <label>到访日期<input v-model="draft.date" type="date"></label>
        <label>备注<textarea v-model="draft.note" rows="2" maxlength="300"></textarea></label>
      </div>
      <div class="actions">
        <button v-if="editing" type="button" @click="removeFootprint">取消点亮</button>
        <button class="primary" type="submit">保存</button>
      </div>
    </form>
  </dialog>

  <dialog ref="importer" @cancel="importing && $event.preventDefault()">
    <form @submit.prevent="importRecords">
      <div class="bar modalhead">
        <h2>{{ importMode === 'cities' ? '批量点亮城市' : '导入足迹备份' }}</h2>
        <button type="button" aria-label="关闭" :disabled="importing" @click="importer.close()">×</button>
      </div>
      <label v-if="importMode === 'cities'">粘贴城市名单，可用顿号、逗号或换行分隔
        <textarea v-model="cityList" rows="5" placeholder="北京市、杭州市、广州市" required></textarea>
      </label>
      <label v-else>选择本项目导出的 JSON 文件
        <input :key="importSession" type="file" accept=".json,application/json" :disabled="importing" required @change="importFile = $event.target.files[0]">
      </label>
      <p>导入会合并足迹，已有记录保留本地日期和备注。</p>
      <p v-if="importStatus" role="alert">{{ importStatus }}</p>
      <div class="actions"><button class="primary" type="submit" :disabled="importing">{{ importing ? '正在导入…' : '导入并点亮' }}</button></div>
    </form>
  </dialog>
</template>
