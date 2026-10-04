// Small seeded random helpers shared by the camera, datasets and trainers.
// Everything in FlyKart Vision is reproducible from a seed.

export type Random = () => number;

export function mulberry32(seed: number): Random {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(random: Random): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
}

export const between = (random: Random, low: number, high: number): number => low + (high - low) * random();
export const pick = <T>(random: Random, items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))];

/** Cheap deterministic 2-D lattice hash in [0, 1), used for ground texture. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function shuffleInPlace<T>(items: T[], random: Random): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
