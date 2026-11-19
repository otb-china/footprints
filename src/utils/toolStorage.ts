const toolId = "footprints";
export const storageKeys = {
  records: `${toolId}:records`,
} as const;

const allowedKeys = new Set<string>(Object.values(storageKeys));

const legacyKeys: Readonly<Record<string, string>> = {
  [storageKeys.records]: "footprints-v1",
};

type Values = Record<string, string>;

interface Snapshot {
  revision: number;
  values: Values;
}

const storeName = "data";
const snapshotKey = `${toolId}:snapshot`;
const legacySnapshotKey = "snapshot";
let database: IDBDatabase;
let current: Snapshot;
let writes: Promise<unknown> = Promise.resolve();

export class StorageConflictError extends Error {
  constructor() {
    super("此工具的数据已在另一页面更新，请刷新后重试。");
  }
}

function openDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("数据库升级被其他页面阻塞"));
    };
    request.onupgradeneeded = () => {
      if (blocked) request.transaction?.abort();
      else if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) db.close();
      else {
        db.onversionchange = () => db.close();
        resolve(db);
      }
    };
  });
}

function updateSnapshot(
  update: (saved: Snapshot | undefined, legacy?: Snapshot) => Snapshot,
  migrate = false,
) {
  return new Promise<Snapshot>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(storeName);
    const request = store.get(snapshotKey);
    let result: Snapshot;
    let failure: unknown;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error);
    function applyUpdate(legacy?: Snapshot) {
      try {
        const saved: Snapshot | undefined = request.result;
        result = update(saved, legacy);
        if (result !== saved) store.put(result, snapshotKey);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    }
    request.onsuccess = () => {
      if (!migrate || request.result !== undefined) {
        applyUpdate();
        return;
      }
      const legacy = store.get(legacySnapshotKey);
      legacy.onsuccess = () => applyUpdate(legacy.result);
    };
  });
}

export async function initializeStorage() {
  database = await openDatabase(toolId);
  current = await updateSnapshot((saved, legacy) => {
    if (saved) return saved;
    const values: Values = {};
    for (const [key, alias] of Object.entries(legacyKeys)) {
      const value = legacy
        ? legacy.values[key] ?? legacy.values[alias] ?? null
        : localStorage.getItem(key) ?? localStorage.getItem(alias);
      if (value === null) continue;
      JSON.parse(value);
      values[key] = value;
    }
    return { revision: (legacy?.revision ?? 0) + 1, values };
  }, true);
}

export function readStoredValue(key: string): string | null {
  return current.values[key] ?? null;
}

export function writeStoredValues(changes: Record<string, string | null>): Promise<void> {
  const write = writes.then(async () => {
    current = await updateSnapshot((saved) => {
      if (saved?.revision !== current.revision) throw new StorageConflictError();
      const values = { ...current.values };
      let changed = false;
      for (const [key, value] of Object.entries(changes)) {
        if (!allowedKeys.has(key)) throw new Error(`Unknown storage key: ${key}`);
        if (value === (values[key] ?? null)) continue;
        if (value === null) delete values[key];
        else values[key] = value;
        changed = true;
      }
      return changed ? { revision: current.revision + 1, values } : current;
    });
  });
  writes = write.catch(() => {});
  return write;
}
