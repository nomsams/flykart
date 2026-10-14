// Saving runs in the browser (IndexedDB) so a closed tab or a crash costs at most a minute of evolution.
import type { EngineState } from "./engine";

const DB = "flykart-evolve", STORE = "runs";
type Row = { name: string; savedAt: string; generation: number; stage: number; state: string };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "name" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function saveRun(name: string, state: EngineState): Promise<void> {
  const row: Row = { name, savedAt: new Date().toISOString(), generation: state.generation, stage: state.stage, state: JSON.stringify(state) };
  await tx("readwrite", (s) => s.put(row));
}
export async function loadRun(name: string): Promise<EngineState | null> {
  const row = await tx<Row | undefined>("readonly", (s) => s.get(name));
  return row ? (JSON.parse(row.state) as EngineState) : null;
}
export async function listRuns(): Promise<{ name: string; savedAt: string; generation: number; stage: number }[]> {
  const rows = await tx<Row[]>("readonly", (s) => s.getAll());
  return rows.map(({ name, savedAt, generation, stage }) => ({ name, savedAt, generation, stage })).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function deleteRun(name: string): Promise<void> { await tx("readwrite", (s) => s.delete(name)); }
