import { computed, reactive, shallowRef, watch } from 'vue';

const maxScale = 8;
const step = 1.35;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function useMapZoom(map, areaId, svg) {
  const view = reactive({ scale: 1, x: 0, y: 0 });
  const svgSize = shallowRef(null);
  const mapBox = computed(() => map.value?.viewBox.split(' ').map(Number));
  const viewport = computed(() => {
    if (!mapBox.value) return null;
    const [x, y, width, height] = mapBox.value;
    const size = svgSize.value;
    const fit = size && Math.min(size.width / width, size.height / height);
    const extraX = fit ? (size.width / fit - width) / 2 : 0;
    const extraY = fit ? (size.height / fit - height) / 2 : 0;
    return [x - extraX, y - extraY, x + width + extraX, y + height + extraY];
  });
  const pointers = new Map();
  let start;
  let moved = false;
  const transform = computed(() => 'translate(' + view.x + ' ' + view.y + ') scale(' + view.scale + ')');
  const canZoomIn = computed(() => view.scale < maxScale);
  const canZoomOut = computed(() => view.scale > 1);

  function resetZoom() {
    Object.assign(view, { scale: 1, x: 0, y: 0 });
  }

  watch(areaId, () => {
    pointers.clear();
    moved = false;
    resetZoom();
  });

  watch(svg, (element, _, onCleanup) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      svgSize.value = entry.contentRect;
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  function clampOffset(offset, mapStart, mapEnd, visibleStart, visibleEnd, scale) {
    const min = visibleEnd - mapEnd * scale;
    const max = visibleStart - mapStart * scale;
    return min > max ? (min + max) / 2 : clamp(offset, min, max);
  }

  function moveView(factor, from, to = from) {
    if (!viewport.value) return;
    const scale = clamp(view.scale * factor, 1, maxScale);
    if (scale === 1) {
      resetZoom();
      return;
    }
    const [x, y, width, height] = mapBox.value;
    const [left, top, right, bottom] = viewport.value;
    const ratio = scale / view.scale;
    view.x = clampOffset(to.x - (from.x - view.x) * ratio, x, x + width, left, right, scale);
    view.y = clampOffset(to.y - (from.y - view.y) * ratio, y, y + height, top, bottom, scale);
    view.scale = scale;
  }

  watch(viewport, bounds => {
    if (!bounds || view.scale === 1) return;
    const origin = { x: 0, y: 0 };
    moveView(1, origin);
  });

  function zoom(direction) {
    if (!mapBox.value) return;
    const [x, y, width, height] = mapBox.value;
    moveView(step ** direction, { x: x + width / 2, y: y + height / 2 });
  }

  function point(svg, client) {
    return new DOMPoint(client.x, client.y).matrixTransform(svg.getScreenCTM().inverse());
  }

  function onWheel(event) {
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    moveView(Math.exp(clamp(-delta * 0.002, -0.5, 0.5)),
      point(event.currentTarget, { x: event.clientX, y: event.clientY }));
  }

  function onPointerDown(event) {
    if (event.button !== 0 || pointers.size >= 2) return;
    const client = { x: event.clientX, y: event.clientY };
    if (!pointers.size) {
      start = client;
      moved = false;
    } else moved = true;
    pointers.set(event.pointerId, client);
    event.target.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    const svg = event.currentTarget;
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const ratio = distance(next, other) / Math.max(distance(previous, other), 1);
      moveView(ratio, point(svg, middle(previous, other)), point(svg, middle(next, other)));
    } else {
      if (!moved && distance(start, next) < 5) return;
      moved = true;
      moveView(1, point(svg, previous), point(svg, next));
    }
    pointers.set(event.pointerId, next);
  }

  function onPointerEnd(event) {
    pointers.delete(event.pointerId);
  }

  function onMapClick(event) {
    if (moved && event.detail !== 0) event.stopPropagation();
  }

  return { view, viewport, transform, canZoomIn, canZoomOut, zoom, resetZoom, onWheel, onPointerDown, onPointerMove, onPointerEnd, onMapClick };
}
