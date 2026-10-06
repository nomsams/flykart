import { TRACKS } from './core';
import './map-curriculum.css';
// Generated previews are registered dynamically and are not portable across pages.
export const TRAINING_MAPS=TRACKS.filter(t=>!t.id.startsWith('gen-'));

export function validateTrainingMaps(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > TRAINING_MAPS.length || raw.some(id => typeof id !== 'string' || !TRAINING_MAPS.some(t => t.id === id)) || new Set(raw).size !== raw.length) throw Error('Choose at least one known training map, without duplicates.');
  return TRAINING_MAPS.filter(t => raw.includes(t.id)).map(t => t.id);
}
export function curriculumKey(ids: string[]): 'all' | `all:${string}` {
  const maps = validateTrainingMaps(ids);
  return maps.length === TRAINING_MAPS.length ? 'all' : `all:${maps.join(',')}`;
}

/** One shared, compact curriculum picker. Driving map and training map set stay separate. */
export function mountMapCurriculum(select: HTMLSelectElement, container: HTMLElement, change: () => void, vision = false) {
  const box = document.createElement('details'); box.className = 'map-curriculum';
  box.innerHTML = '<summary>Generalist training maps <output></output></summary><p>Every selected route receives equal weight, using shared training seeds and separate held-out seeds. V2 keeps the driving map above as its preview. Named routes transfer between pages; generated previews can be evolved individually.</p><div class="curriculum-presets"><button type="button" data-set="all">All maps</button><button type="button" data-set="hard">Hard corners</button></div><div class="curriculum-maps"></div>';
  container.append(box);
  const mode = document.createElement('label'); mode.className = 'check-row';
  mode.innerHTML = '<input id="generalist-training" type="checkbox"> Train a generalist on the selected maps';
  if (vision) box.querySelector('p')!.before(mode);
  const checks = TRAINING_MAPS.map(t => {
    const label = document.createElement('label'); label.innerHTML = '<input type="checkbox" checked> <span></span>';
    const input = label.querySelector('input')!; input.value = t.id; input.name = 'training-map'; label.querySelector('span')!.textContent = t.name;
    box.querySelector('.curriculum-maps')!.append(label);
    input.onchange = () => { if (!checks.some(c => c.checked)) input.checked = true; changed(); };
    return input;
  });
  const enabled = () => vision ? mode.querySelector('input')!.checked : select.value === 'all';
  const read = () => checks.filter(c => c.checked).map(c => c.value);
  const refresh = () => {
    box.querySelector('output')!.textContent = `${read().length}/${TRAINING_MAPS.length}${enabled() ? ' active' : ''}`;
    checks.forEach(c => c.disabled = select.disabled);
    box.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = select.disabled);
    if (vision) mode.querySelector('input')!.disabled = select.disabled;
  };
  const changed = () => { refresh(); change(); };
  box.querySelectorAll<HTMLButtonElement>('[data-set]').forEach(b => b.onclick = () => {
    const hard = ['switchback','hairpin','deep-hairpin','sharp-turn','chicane','corkscrew','mountain-pass','tight-corners','needle-eye'];
    checks.forEach(c => c.checked = b.dataset.set === 'all' || hard.includes(c.value));
    if (vision) mode.querySelector('input')!.checked = true; else select.value = 'all';
    changed();
  });
  if (vision) mode.querySelector('input')!.onchange = changed;
  select.addEventListener('change', refresh);
  new MutationObserver(refresh).observe(select, { attributes: true, attributeFilter: ['disabled'] }); refresh();
  return { read, enabled, write(ids: unknown, active = true) { const maps = validateTrainingMaps(ids); checks.forEach(c => c.checked = maps.includes(c.value)); if (vision) mode.querySelector('input')!.checked = active; refresh(); } };
}
