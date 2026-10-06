import { validateTrainingMaps } from './map-curriculum';
import { DEFAULT_REWARD_CONFIG, RewardConfig, RoadObjectKind } from './core';

// Portable scoring contract. Rewards remain external labels, never controller inputs.
export const REWARD_FIELDS: [keyof RewardConfig, string, number][] = [
  ['progressPerSecond','New route coverage',100], ['correctDirectionPerSecond','Right direction / sec',20],
  ['movementPerSecond','Moving / sec',20], ['standingStillPerSecond','Standing still / sec',20],
  ['wrongDirectionPerSecond','Wrong direction / sec',30], ['reverseProgressPerSecond','Backtracking',30],
  ['offTrackPerSecond','Outside track / sec',200], ['edgePenaltyPerSecond','Near edge / sec',20],
  ['proximityPenaltyPerSecond','Close traffic / sec',100], ['hazardPenaltyPerSecond','Hazard contact / sec',100],
  ['centerlinePerSecond','Centerline / sec',20], ['controlChangePerSecond','Control jitter / sec',20],
  ['controlConflictPerSecond','Throttle + brake / sec',20], ['spikeEnergyPerSecond','Spike energy / sec',20],
  ['collision','Collision',100], ['crash','Crash',200], ['checkpoint','Checkpoint',1000], ['finish','Finish',1000],
];
export type TrainingRecipe = {
  version: 1; domain: 'race'; reward: RewardConfig; trainingMaps?:string[];
  physics: { wallsEnabled: boolean; lapTarget: number; impactPain: boolean; checkpointCount: number; domainRandomization: number };
  obstacles: { enabled: boolean; count: number; kind: RoadObjectKind | 'mixed' };
};
export function validateRewards(raw: unknown): RewardConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid racing reward weights.');
  const result = { ...DEFAULT_REWARD_CONFIG };
  for (const [key, , max] of REWARD_FIELDS) {
    const value = (raw as RewardConfig)[key] ?? DEFAULT_REWARD_CONFIG[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`Invalid racing reward: ${key}.`);
    result[key] = value;
  }
  return result;
}
export function validateRecipe(raw: unknown): TrainingRecipe {
  const r = raw as TrainingRecipe, p = r?.physics, o = r?.obstacles;
  if (r?.version !== 1 || r.domain !== 'race' || !p || !o ||
      typeof p.wallsEnabled !== 'boolean' || typeof p.impactPain !== 'boolean' ||
      ![1,2,3,5].includes(p.lapTarget) || !Number.isInteger(p.checkpointCount) || p.checkpointCount < 2 || p.checkpointCount > 64 ||
      !Number.isFinite(p.domainRandomization) || p.domainRandomization < 0 || p.domainRandomization > .35 ||
      typeof o.enabled !== 'boolean' || !Number.isInteger(o.count) || o.count < 0 || o.count > 64 ||
      !['mixed','stalled-car','barrier','cone','oil','wall','bush'].includes(o.kind)) throw new Error('Invalid racing training recipe.');
  return { version: 1, domain: 'race', ...(r.trainingMaps?{trainingMaps:validateTrainingMaps(r.trainingMaps)}:{}), reward: validateRewards(r.reward), physics: { ...p }, obstacles: { ...o } };
}
/** Default race units map to default habitat units; the exact original remains in the checkpoint. */
export function roomRewards(recipe: TrainingRecipe): { pain: number; sugar: number; trailReward: number } {
  return { pain: Math.min(10, recipe.reward.collision / 10), sugar: Math.min(100, recipe.reward.finish / 30), trailReward: Math.min(20, recipe.reward.checkpoint / 50) };
}
