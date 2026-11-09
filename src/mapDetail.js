import { computed, shallowRef, watch } from 'vue';
import { shape } from './map.js';

const intersects = (bounds, [left, top, right, bottom]) =>
  bounds[0] <= right && bounds[2] >= left && bounds[1] <= bottom && bounds[3] >= top;

export function useMapDetail(map, view, children, isLit) {
  const detail = shallowRef({ cities: [], districts: [] });
  const viewport = computed(() => {
    if (!map.value) return null;
    const [x, y, width, height] = map.value.viewBox.split(' ').map(Number);
    return [x, y, x + width, y + height];
  });
  const zoomedBounds = computed(() => viewport.value?.map((value, index) =>
    (value - (index % 2 ? view.y : view.x)) / view.scale
  ));

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
    if (currentMap !== previousMap || scale < 1.7) detail.value = { cities: [], districts: [] };
    else if (scale < 3.5 && detail.value.districts.length) detail.value = { ...detail.value, districts: [] };
    if (!currentMap || scale < 1.7) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const cities = await loadChildren(currentMap, currentMap.paths, bounds);
      if (cancelled) return;
      detail.value = { cities, districts: detail.value.districts };
      if (scale < 3.5) return;
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
    const layers = [...detail.value.districts, ...detail.value.cities, ...map.value.paths];
    const highlighted = [...map.value.overlays, ...layers.filter(item => isLit(item.adcode))];
    const visited = new Set(highlighted.map(item => item.adcode));
    const seen = new Set();
    for (const { label } of [...highlighted, ...layers]) {
      if (!label?.text || seen.has(label.adcode)) continue;
      seen.add(label.adcode);
      const x = label.x * view.scale + view.x;
      const y = label.y * view.scale + view.y;
      const halfWidth = label.text.length * 8;
      if (x - halfWidth < left || x + halfWidth > right || y < top + 15 || y > bottom - 5) continue;
      if (result.some(other => Math.abs(other.y - y) < 18 && Math.abs(other.x - x) < other.halfWidth + halfWidth + 4)) continue;
      result.push({ ...label, x, y, halfWidth, highlighted: visited.has(label.adcode) });
    }
    return result;
  });

  return { detail, labels };
}
