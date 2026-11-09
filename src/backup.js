const format = 'footprints';
const version = 1;

export function serializeBackup(records) {
  return JSON.stringify({ format, version, exportedAt: new Date().toISOString(), records }, null, 2);
}

export function parseBackup(text, regionFor) {
  const backup = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (backup?.format !== format || backup.version !== version ||
      !backup.records || typeof backup.records !== 'object' || Array.isArray(backup.records)) {
    throw new Error('请选择由本项目导出的足迹 JSON 备份。');
  }

  const entries = Object.entries(backup.records).map(([id, record]) => {
    const region = /^\d{6}$/.test(id) && regionFor(Number(id));
    if (!region?.p || !record || typeof record !== 'object' || Array.isArray(record) ||
        record.p !== region.p || record.c !== region.c || record.d !== region.d ||
        typeof record.date !== 'string' || !validDate(record.date) ||
        typeof record.note !== 'string' || record.note.length > 300) {
      throw new Error('备份中有无效的足迹记录（' + id + '），请检查文件。');
    }
    return [id, { ...region, date: record.date, note: record.note }];
  });
  return Object.fromEntries(entries);
}

function validDate(date) {
  if (!date) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
