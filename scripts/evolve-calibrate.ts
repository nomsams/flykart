// Compares the fast analytic flag cue with the real software camera + FlagDiscovery on random poses (npx vite-node scripts/evolve-calibrate.ts).
import { buildScenario } from "../src/evolve/scenario";
import { WorldEpisode } from "../src/vision/world/worldDomain";
import { ROBOT_PROFILE } from "../src/vision/robot";
import { mulberry32 } from "../src/vision/rng";
import { FlagDiscovery } from "../src/vision/world/discovery";
import { SolidIndex } from "../src/evolve/solid-index";
import { flagCue, CAMERA, FLAG_K } from "../src/evolve/drive";

const rnd = mulberry32(42);
let agree = 0, both = 0, onlyReal = 0, onlyModel = 0, none = 0, bearErr: number[] = [], sizeErr: number[] = [];
const rows: any[] = [];
for (let n = 0; n < 60; n++) {
  const habitat = (["lawn", "street", "apartment"] as const)[n % 3];
  const sc = buildScenario({ habitat, seed: 100 + n, difficulty: 0.5, goals: 1, minPath: 60, maxPath: 260, maxTicks: 1500 });
  const g = sc.goals[0];
  // Poses on a ring around the flag at random distances, facing roughly toward it with scatter.
  for (let k = 0; k < 6; k++) {
    const dist = 40 + rnd() * 170, ang = rnd() * Math.PI * 2;
    const x = g.x + Math.cos(ang) * dist, y = g.y + Math.sin(ang) * dist;
    if (Math.abs(x) > sc.world.half - 14 || Math.abs(y) > sc.world.half - 14) continue;
    const heading = Math.atan2(g.y - y, g.x - x) + (rnd() * 2 - 1) * 1.1;
    const ep = new WorldEpisode({ seed: n, world: sc.world, start: { x, y, heading }, goals: [g], goalLimit: 1, maxTicks: 100, headless: false, profile: ROBOT_PROFILE });
    const frame = ep.render();
    const disc = new FlagDiscovery(48, 24, ROBOT_PROFILE.worldCamera.hfov);
    disc.observe(frame, 1);
    const real = disc.cue(), realVisible = disc.tracker.current.visible;
    const index = new SolidIndex(ep.sim.world, mulberry32(1));
    const model = flagCue(index, ep.sim.kart.x, ep.sim.kart.y, ep.sim.kart.heading, g.x, g.y, 1, 0, rnd);
    if (realVisible && model.visible) { both++; bearErr.push(Math.abs(real[0] - model.bearing)); sizeErr.push(model.size - real[1]); }
    else if (realVisible) { onlyReal++; rows.push({ kind: "onlyReal", dist: dist.toFixed(0), habitat }); }
    else if (model.visible) { onlyModel++; rows.push({ kind: "onlyModel", dist: dist.toFixed(0), habitat, px: model.pixels }); }
    else none++;
  }
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
console.log({ both, onlyReal, onlyModel, none, meanBearErr: mean(bearErr), meanSizeErr: mean(sizeErr), absSize: mean(sizeErr.map(Math.abs)), K: FLAG_K });
console.log(rows.slice(0, 12));
