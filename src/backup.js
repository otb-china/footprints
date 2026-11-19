import { isMapPoint } from './map.js';

const format = 'footprints';

export function serializeBackup(records) {
  const version = Object.values(records).some(record => record.attractions?.length) ? 2 : 1;
  return JSON.stringify({ format, version, exportedAt: new Date().toISOString(), records }, null, 2);
}

export function parseBackup(text, regionFor) {
  const backup = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (backup?.format !== format || ![1, 2].includes(backup.version) ||
      !backup.records || typeof backup.records !== 'object' || Array.isArray(backup.records)) {
    throw new Error('请选择由本项目导出的足迹 JSON 备份。');
  }

  const entries = Object.entries(backup.records).map(([id, record]) => {
    const region = /^\d{6}$/.test(id) && regionFor(Number(id));
    if (!region?.p || !record || typeof record !== 'object' || Array.isArray(record) ||
        record.p !== region.p || record.c !== region.c || record.d !== region.d ||
        typeof record.date !== 'string' || !validDate(record.date) ||
        typeof record.note !== 'string' || record.note.length > 300 ||
        (record.attractions !== undefined && (backup.version !== 2 || !validAttractions(record.attractions)))) {
      throw new Error('备份中有无效的足迹记录（' + id + '），请检查文件。');
    }
    const result = { ...region, date: record.date, note: record.note };
    if (record.attractions?.length) {
      result.attractions = record.attractions.map(({ id, name, point, source }) =>
        ({ id, name, point, ...(source ? { source } : {}) }));
    }
    return [id, result];
  });
  return Object.fromEntries(entries);
}

function validAttractions(attractions) {
  return Array.isArray(attractions) && attractions.every(item =>
    typeof item?.id === 'string' && Boolean(item.id.trim()) &&
    typeof item.name === 'string' && Boolean(item.name.trim()) && isMapPoint(item.point) &&
    (item.source === undefined || item.source === 'osm')
  ) && new Set(attractions.map(item => item.id)).size === attractions.length;
}

function validDate(date) {
  if (!date) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
