import { importFile } from './vision/format';
import projectRacer from '../assets/flykart-brain-racer.json?raw';
const projectGeneration: number = JSON.parse(projectRacer).generation;
export type BrainStage = 'racer' | 'vision' | 'robot';
type SavedBrain = { stage: BrainStage; savedAt: string; text: string };
const STORE = 'brains', PREFIX = 'flykart.shared-brain.';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('flykart-browser-brains', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'stage' });
    let blocked=false;
    request.onsuccess = () => { if(blocked)request.result.close();else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked=true;reject(new Error('Close other FlyKart tabs to unlock browser storage.')); };
  });
}
async function stored(): Promise<SavedBrain[]> {
  try {
    const db = await database();
    try { return await new Promise<SavedBrain[]>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  } catch { return []; }
}
export async function saveBrowserBrain(stage: BrainStage, text: string): Promise<void> {
  // Parse before replacing a saved checkpoint. Storage writes are atomic.
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !['flykart-brain','flykart-vision-brain'].includes(parsed.format)) throw new Error('Save a complete controller checkpoint.');
  if(!importFile(text).controller)throw new Error('Save a complete controller checkpoint.');
  const record: SavedBrain = { stage, text, savedAt: new Date().toISOString() };
  try {
    const db = await database();
    try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
    finally { db.close(); }
  } catch {
    try { localStorage.setItem(PREFIX + stage, JSON.stringify(record)); }
    catch { throw new Error('Browser storage is unavailable or full. Export a JSON file instead.'); }
  }
}
export async function loadBrowserBrain(stage?: BrainStage): Promise<SavedBrain> {
  const records = await stored();
  for (const key of ['racer','vision','robot'] as BrainStage[]) {
    try { const raw = localStorage.getItem(PREFIX + key); if (raw) records.push(JSON.parse(raw)); } catch { /* May be blocked in private browsing. */ }
  }
  // Keep the legacy save as a last resort, including when a new record is corrupt.
  try { const text = localStorage.getItem('flykart.best-brain.v1'); if (text) records.push({ stage:'racer', text, savedAt:'' }); } catch { /* optional legacy fallback */ }
  const record = records.filter(r => {
    if(!r || !['racer','vision','robot'].includes(r.stage) || typeof r.text!=='string' || typeof r.savedAt!=='string' || (stage && r.stage!==stage))return false;
    try{return Boolean(importFile(r.text).controller);}catch{return false;}
  }).sort((a,b) => b.savedAt.localeCompare(a.savedAt))[0];
  if (!record) throw new Error('No browser brain saved here yet. Save one on Racer, Vision or 3D first, using the same browser and site address.');
  return record;
}
export function mountBrainShelf(host: HTMLElement, stage: BrainStage, exportText: () => string, importText: (text: string, name: string) => void | Promise<void>, busy: () => boolean, existing?: {save: HTMLButtonElement; load: HTMLButtonElement}, importProject = importText): void {
  const shelf = document.createElement('details'); shelf.className = 'browser-brain-shelf'; shelf.open = true;
  shelf.innerHTML = `<summary>Browser brains · Racer → Vision → 3D</summary><div class="toolbar row"><label>Load from<select aria-label="Browser brain source"><option value="">Most recent save</option><option value="racer">Racer v1</option><option value="vision">Vision v2</option><option value="robot">3D habitat</option></select></label><button type="button" data-brain-save>Save browser brain</button><button type="button" data-brain-load>Load browser brain</button></div><small>One checkpoint per stage, including rewards and eyes. Same browser + site address. Export JSON for other devices. <a href="./index.html">Racer</a> → <a href="./vision.html">Vision</a> → <a href="./robot.html">3D</a></small><p role="status" class="note"></p>`;
  host.append(shelf);
  const project = document.createElement('div');
  project.className = 'toolbar row';
  const loadProject = document.createElement('button');
  loadProject.type = 'button'; loadProject.id = 'load-racer-checkpoint';
  loadProject.textContent = `Load repository brain · generation ${projectGeneration}`;
  loadProject.title = 'Load assets/flykart-brain-racer.json with its exact weights, rewards and race setup. Available again after any import.';
  const description = document.createElement('small');
  description.textContent = 'GitHub repository checkpoint: assets/flykart-brain-racer.json · your trained Racer v1 brain, bundled with this site. Separate from browser saves and the original demo brain.';
  project.append(loadProject, description); shelf.querySelector('summary')!.after(project);
  if (existing) {
    host.querySelector(':scope > .toolbar')?.after(shelf);
    for (const [key, button] of Object.entries(existing)) { const placeholder=shelf.querySelector(`[data-brain-${key}]`)!;button.textContent=`${key === 'save' ? 'Save' : 'Load'} browser brain`;button.setAttribute(`data-brain-${key}`,'');placeholder.replaceWith(button); }
  }
  const status = shelf.querySelector<HTMLElement>('[role=status]')!;
  const operate = async (action: () => Promise<string>) => {
    if (busy()) { status.textContent = 'Stop the active job before saving or loading a browser brain.'; return; }
    const buttons = shelf.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(b => b.disabled = true);
    try { status.textContent = await action(); } catch(e) { status.textContent = (e as Error).message; }
    finally { buttons.forEach(b => b.disabled = false); }
  };
  loadProject.onclick = () => void operate(async () => {
    await importProject(projectRacer, 'flykart-brain-racer.json');
    return `Loaded assets/flykart-brain-racer.json · generation ${projectGeneration}. Exact racer checkpoint retained.${stage === 'racer' ? ' Press Start race to run it.' : stage === 'vision' ? ' Train camera offspring in Track; use Adapt racer to room for Open world.' : ' Use Tasks → Adapt racer to room before room training.'}`;
  });
  shelf.querySelector<HTMLButtonElement>('[data-brain-save]')!.onclick = () => void operate(async () => { await saveBrowserBrain(stage, exportText()); return `Saved ${stage} brain here. Open the next page and choose “Load browser brain”. Other stage saves are kept.`; });
  shelf.querySelector<HTMLButtonElement>('[data-brain-load]')!.onclick = () => void operate(async () => { const choice = shelf.querySelector('select')!.value as BrainStage; const record = await loadBrowserBrain(choice || undefined); if(busy())throw new Error('A job started while loading. Stop it, then load the brain again.');await importText(record.text, `${record.stage} browser checkpoint`); return `Loaded ${record.stage} brain${record.savedAt ? ' · ' + new Date(record.savedAt).toLocaleString() : ''}.`; });
}
