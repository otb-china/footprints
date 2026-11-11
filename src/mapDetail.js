import { computed, onMounted, shallowRef, watch } from 'vue';
import { coordinates, readJson, root, shape } from './map.js';

const intersects = (bounds, [left, top, right, bottom]) =>
  bounds[0] <= right && bounds[2] >= left && bounds[1] <= bottom && bounds[3] >= top;
const overlapsLabel = (a, b) =>
  Math.abs(a.y - b.y) < 18 && Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + 4;

export function useMapDetail(map, view, viewport, children, isLit, areaId, levelOf) {
  const detail = shallowRef({ cities: [], districts: [] });
  const attractionData = shallowRef(null);
  onMounted(async () => {
    try {
      attractionData.value = await readJson('attractions.json');
    } catch (error) {
      console.warn('景点数据加载失败', error);
    }
  });
  const zoomedBounds = computed(() => viewport.value?.map((value, index) =>
    (value - (index % 2 ? view.y : view.x)) / view.scale
  ));

  const national = computed(() => areaId.value === root);
  const cityZoom = computed(() => national.value ? 2.6 : 2);
  const districtZoom = computed(() => national.value ? 7 : 4);
  const projectedAttractions = computed(() => {
    if (!map.value || !attractionData.value) return [];
    const area = areaId.value;
    return attractionData.value.places
      .filter(item => area === root || item.areas.includes(area))
      .map(item => ({ ...item, point: map.value.projectPoint(coordinates(...item.location)) }));
  });
  const markers = computed(() => {
    if (!map.value) return [];
    const area = areaId.value;
    const minZoom = national.value ? 4 : levelOf(area) === 'province' ? cityZoom.value : 1;
    if (view.scale < minZoom) return [];
    const [left, top, right, bottom] = viewport.value;
    const result = [];
    const occupied = [];
    for (const { id, name, point: [mapX, mapY] } of projectedAttractions.value) {
      const x = mapX * view.scale + view.x;
      const y = mapY * view.scale + view.y;
      if (x < left + 8 || x > right - 8 || y < top + 20 || y > bottom - 2) continue;
      const text = name.length > 12 ? name.slice(0, 11) + '…' : name;
      const halfWidth = text.length * 8;
      const labelX = Math.max(left + halfWidth, Math.min(right - halfWidth, x));
      const labelY = y < top + 40 ? y + 17 : y - 22;
      const labelBox = { x: labelX, y: labelY, halfWidth };
      const label = occupied.some(other => overlapsLabel(other, labelBox)) ? '' : text;
      if (label) occupied.push(labelBox);
      result.push({ id, name, x, y, label, labelBox });
    }
    return result;
  });

  async function loadChildren(currentMap, parents, bounds) {
    const layers = await Promise.all(parents
      .filter(item => intersects(item.bounds, bounds))
      .map(async item => {
        const codes = new Set(children(item.adcode).map(area => area.adcode));
        if (!codes.size) return [];
        const geo = await shape(item.adcode);
        return (geo?.features || [])
          .filter(feature => feature.geometry && codes.has(feature.properties.adcode))
          .map(currentMap.projectFeature);
      }));
    return layers.flat();
  }

  watch([map, zoomedBounds], ([currentMap, bounds], [previousMap], onCleanup) => {
    const scale = view.scale;
    if (currentMap !== previousMap || scale < cityZoom.value) detail.value = { cities: [], districts: [] };
    else if (scale < districtZoom.value && detail.value.districts.length) detail.value = { ...detail.value, districts: [] };
    if (!currentMap || scale < cityZoom.value) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const childrenInView = await loadChildren(currentMap, currentMap.paths, bounds);
      const cities = national.value && scale < districtZoom.value
        ? childrenInView.filter(item => levelOf(item.adcode) !== 'district')
        : childrenInView;
      if (cancelled) return;
      detail.value = { cities, districts: detail.value.districts };
      if (scale < districtZoom.value) return;
      const districts = await loadChildren(currentMap, cities, bounds);
      if (!cancelled) detail.value = { cities, districts };
    }, 100);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  const labels = computed(() => {
    if (!map.value) return [];
    const [left, top, right, bottom] = viewport.value;
    const result = [];
    const occupied = markers.value.filter(marker => marker.label).map(marker => marker.labelBox);
    const layers = [...detail.value.districts, ...detail.value.cities, ...map.value.paths];
    const priority = [...map.value.overlays, ...layers.filter(item => isLit(item.adcode))];
    const visited = new Set(priority.map(item => item.adcode));
    const seen = new Set();
    const nationalOverview = national.value && view.scale < cityZoom.value;
    let overviewLabels = 0;
    for (const { label } of [...priority, ...layers]) {
      if (!label?.text || seen.has(label.adcode)) continue;
      const highlighted = visited.has(label.adcode);
      if (national.value && !highlighted) {
        const level = levelOf(label.adcode);
        if ((nationalOverview && overviewLabels >= 10) ||
            (level === 'city' && view.scale < cityZoom.value) ||
            (level === 'district' && view.scale < districtZoom.value)) continue;
      }
      seen.add(label.adcode);
      const x = label.x * view.scale + view.x;
      const y = label.y * view.scale + view.y;
      const halfWidth = label.text.length * 8;
      if (x - halfWidth < left || x + halfWidth > right || y < top + 15 || y > bottom - 5) continue;
      const labelBox = { x, y, halfWidth };
      if (occupied.some(other => overlapsLabel(other, labelBox))) continue;
      occupied.push(labelBox);
      result.push({ ...label, x, y, halfWidth, highlighted });
      if (nationalOverview && !highlighted) overviewLabels++;
    }
    return result;
  });

  return { detail, labels, markers, attractionData };
}
