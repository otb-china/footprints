import { computed, reactive, watch } from 'vue';

const maxScale = 8;
const step = 1.35;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function useMapZoom(map, areaId) {
  const view = reactive({ scale: 1, x: 0, y: 0 });
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

  function moveView(factor, from, to = from) {
    if (!map.value) return;
    const [x, y, width, height] = map.value.viewBox.split(' ').map(Number);
    const scale = clamp(view.scale * factor, 1, maxScale);
    const ratio = scale / view.scale;
    const shift = 1 - scale;
    view.x = clamp(to.x - (from.x - view.x) * ratio, (x + width) * shift, x * shift);
    view.y = clamp(to.y - (from.y - view.y) * ratio, (y + height) * shift, y * shift);
    view.scale = scale;
  }

  function zoom(direction) {
    const [x, y, width, height] = map.value.viewBox.split(' ').map(Number);
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

  return { view, transform, canZoomIn, canZoomOut, zoom, resetZoom, onWheel, onPointerDown, onPointerMove, onPointerEnd, onMapClick };
}
