import {TRACKS} from './core';
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
