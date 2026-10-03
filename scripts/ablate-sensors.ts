// How much does a trained brain depend on each family of sensors, and how much
// perception error / delay can it tolerate? Runs the real controller, sensors
// and physics with the sensor vector deliberately damaged.
//   npx vite-node scripts/ablate-sensors.ts [public/sample-brain.json]
import { readFileSync } from "node:fs";
import { DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, SpikingNetwork, TRACKS, sensorValues, startPosition, stepCar } from "../src/core";

const file = JSON.parse(readFileSync(process.argv[2] ?? "public/sample-brain.json", "utf8"));
const MAP = [0, 1, 2, 4, 7, 8, 11, 12, 13];       // road geometry that a map (or a camera) would supply
const TRAFFIC = [5, 6, 9, 10, 16];                 // other karts and objects
const SELF = [3, 14, 15];                           // speed and own last action: proprioception
const trackIds = ["grand-loop", "hairpin", "oval-sprint", "chicane", "mountain-pass", "sharp-turn"];
const physics = { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: false };

function mulberry32(seed: number) { let a = seed; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (random: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());

type Damage = (sensors: number[], history: number[][], random: () => number) => number[];
const conditions: [string, Damage][] = [
  ["intact", (s) => s],
  ["blind to road geometry", (s) => s.map((v, i) => (MAP.includes(i) ? 0 : v))],
  ["blind to traffic", (s) => s.map((v, i) => (TRAFFIC.includes(i) ? 0 : v))],
  ["no proprioception", (s) => s.map((v, i) => (SELF.includes(i) ? 0 : v))],
  ...[0.05, 0.1, 0.2, 0.4].map((sigma): [string, Damage] => [`road noise σ=${sigma}`, (s, _h, r) => s.map((v, i) => (MAP.includes(i) ? Math.max(-1, Math.min(1, v + sigma * gauss(r))) : v))]),
  ...[3, 6, 10].map((delay): [string, Damage] => [`road delayed ${delay} ticks (${Math.round(delay * 1000 / 30)} ms)`, (s, h) => { const old = h[Math.max(0, h.length - 1 - delay)] ?? s; return s.map((v, i) => (MAP.includes(i) ? old[i] : v)); }]),
];

function run(damage: Damage, trackId: string): string {
  const route = TRACKS.find((track) => track.id === trackId)!;
  const network = SpikingNetwork.fromJSON(file.network);
  const car = startPosition(0, route); car.network = network; car.timeLimit = 4500; network.reset();
  const random = mulberry32(1234); const history: number[][] = [];
  for (let tick = 0; tick < 4500 && !car.crashed && !car.finished && !car.timedOut && !car.eliminated; tick += 1) {
    const sensors = sensorValues(car, [car], route); history.push(sensors);
    stepCar(car, network.step(damage(sensors, history, random)), [car], route, DEFAULT_REWARD_CONFIG, physics);
  }
  return car.finished ? `LAP ${(car.ticks / 30).toFixed(0)}s` : `${Math.round(car.totalProgress * 100)}%${car.crashed ? " crash" : ""}`;
}

console.log("condition".padEnd(34) + trackIds.map((id) => id.slice(0, 11).padEnd(13)).join(""));
for (const [name, damage] of conditions) console.log(name.padEnd(34) + trackIds.map((id) => run(damage, id).padEnd(13)).join(""));
