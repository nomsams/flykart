// The measurements behind the Evidence tab. Everything runs on tracks and worlds the networks never trained on.
//   npx vite-node scripts/experiments.ts --out=public/vision/results.json [--quick]
import { readFileSync, writeFileSync } from "node:fs";
import { SpikingNetwork, TRACKS } from "../src/core";
import { DEFAULT_STYLE, Style } from "../src/vision/camera";
import { driveEpisode, summarise } from "../src/vision/evaluate";
import type { Summary } from "../src/vision/evaluate";
import { fadeSchedule } from "../src/vision/fusion";
import { ESTIMATE_NAMES } from "../src/vision/interface";
import { MushroomBody } from "../src/vision/memory";
import { Perceiver, VisionModel } from "../src/vision/perception";
import { DriverMode, VisionDriver } from "../src/vision/pipeline";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { trackDomain, worldDomain } from "../src/vision/domains";
import { driveWorldEpisode, runWorldEpisode } from "../src/vision/world/worldRun";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const quick = args.has("quick");
const out = args.get("out") ?? "public/vision/results.json";
const only = (args.get("only") ?? "closed,memory,world").split(",");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const robust = SpikingNetwork.fromJSON(load(args.get("controller") ?? "public/vision/controller.json").network);
const original = SpikingNetwork.fromJSON(load(args.get("v1") ?? "public/sample-brain.json").network);
const visionModel: VisionModel = load(args.get("vision") ?? "public/vision/vision-net.json");
const stamp = (() => { const t0 = performance.now(); return () => `${((performance.now() - t0) / 1000).toFixed(0)}s`; })();

const named = TRACKS.filter((t) => !t.id.startsWith("gen-"));
const heldNamed = ["mountain-pass", "needle-eye", "rainbow-rally", "oval-sprint"].map((id) => named.find((t) => t.id === id)!);
const heldGenerated = Array.from({ length: 4 }, (_, i) => proceduralTrack(40 + i));
const suite = quick ? [heldNamed[0], heldGenerated[0]] : [...heldNamed, ...heldGenerated];
const maxTicks = quick ? 1500 : 3600;

type Row = { label: string; laps: number; episodes: number; progress: number; meanLapSeconds: number | null; offRoad: number; strictLaps: number; strictProgress: number; strictCrashes: number };
const toRow = (label: string, normal: Summary, strict: Summary): Row => ({ label, laps: normal.laps, episodes: normal.episodes, progress: normal.meanProgress, meanLapSeconds: normal.meanLapSeconds, offRoad: normal.meanOffTrack, strictLaps: strict.laps, strictProgress: strict.meanProgress, strictCrashes: strict.crashes });

type Config = { label: string; controller: SpikingNetwork; eyes: boolean; fade?: number; mode?: DriverMode; blind?: boolean; fadeDuringLap?: boolean; traffic?: boolean };

function drive(config: Config, strict: boolean): Summary {
  const perceiver = config.eyes ? new Perceiver(visionModel) : null;
  const controller = config.controller.clone();
  const driver = new VisionDriver({ perceiver, controller, domain: trackDomain, mode: config.mode ?? "belief", blind: config.blind, fusion: { fade: config.fade ?? 0 }, feelingController: config.controller.clone() });
  return summarise(suite.map((track, i) => driveEpisode(driver, {
    track, seed: 7 + i, styleStrength: 0.5, maxTicks, walls: !strict, rivals: config.traffic ? 1 : 0, roadObjects: config.traffic ? 2 : 0,
    beforeTick: config.fadeDuringLap ? (episode, d) => { d.fusion.fade = fadeSchedule(episode.car.totalProgress); } : undefined,
  })));
}

const results: Record<string, any> = { generatedAt: new Date().toISOString(), note: quick ? "quick run" : "full run" };
try { Object.assign(results, JSON.parse(readFileSync(out, "utf8"))); } catch { /* first run */ }
results.generatedAt = new Date().toISOString();

/* ---- vision accuracy comes from the training run ---- */
results.vision = { names: [...ESTIMATE_NAMES], metrics: visionModel.metrics ?? null, heldOut: visionModel.metrics?.heldOut ?? "", network: `${visionModel.spec.channels.join("-")} convolution channels, ${visionModel.spec.hidden} hidden units, ${Math.round(visionModel.params.length * 0.75 / 4)} weights; ${visionModel.notes ?? ""}` };

for (const [key, path] of [["architecture", "public/vision/results-architecture.json"], ["pushPull", "public/vision/results-pushpull.json"]] as const) { try { results[key] = load(path); } catch { /* optional */ } }

/* ---- closed loop ---- */
if (only.includes("closed")) {
  const configs: Config[] = [
    { label: "Feeling only · original FlyKart brain (exact numbers, as in v1)", controller: original, eyes: false },
    { label: "Feeling only · robust controller (exact numbers)", controller: robust, eyes: false },
    { label: "Blind · robust controller (all estimates zero)", controller: robust, eyes: false, blind: true },
    { label: "Seeing only · original FlyKart brain", controller: original, eyes: true },
    { label: "Seeing only · robust controller", controller: robust, eyes: true },
    { label: "Fusion · feeling weight 1", controller: robust, eyes: true, fade: 1 },
    { label: "Fusion · feeling weight 0.1", controller: robust, eyes: true, fade: 0.1 },
    { label: "Fusion · feeling weight 0.01", controller: robust, eyes: true, fade: 0.01 },
    { label: "Fusion · feeling weight 0.001", controller: robust, eyes: true, fade: 0.001 },
    { label: "Fusion · feeling faded 1 → 0 during the lap", controller: robust, eyes: true, fadeDuringLap: true, fade: 1 },
    { label: "Averaging two brains’ actions (50/50)", controller: robust, eyes: true, fade: 0.5, mode: "action-average" },
    { label: "Camera’s own action guess (no controller)", controller: robust, eyes: true, mode: "vision-action" },
    { label: "Traffic: feeling only · robust controller", controller: robust, eyes: false, traffic: true },
    { label: "Traffic: seeing only · robust controller", controller: robust, eyes: true, traffic: true },
    { label: "Traffic: fusion · feeling weight 0.1", controller: robust, eyes: true, fade: 0.1, traffic: true },
  ];
  const rows: Row[] = [];
  for (const config of configs) {
    const normal = drive(config, false), strict = drive(config, true);
    rows.push(toRow(config.label, normal, strict));
    console.log(`${config.label.padEnd(66)} walls: ${normal.laps}/${normal.episodes} laps ${(normal.meanProgress * 100).toFixed(0)}%  no walls: ${strict.laps}/${strict.episodes} laps ${(strict.meanProgress * 100).toFixed(0)}% ${strict.crashes} crashes  (${stamp()})`);
  }
  results.closedLoop = { description: `${suite.length} tracks the camera network never trained on (${suite.map((t) => t.id).join(", ")}), colours randomised a little. “Laps (walls)” is the simulator’s normal road-side walls; “no walls” makes leaving the road for real, which is a much stricter test of what the camera sees. Each driver ran each track once, so a difference of a lap or two is within noise.`, rows };
}

/* ---- the lap memory ---- */
if (only.includes("memory")) {
  const GEOMETRY = ["headingError", "curvature", "curveNear", "curveFar"].map((name) => ESTIMATE_NAMES.indexOf(name as never));
  const LIGHTS: { id: string; label: string; style: Style }[] = [
    { id: "dusk", label: "dusk (brightness 0.62, noise 0.04)", style: { ...DEFAULT_STYLE, brightness: 0.62, contrast: 0.85, noise: 0.04 } },
    { id: "dim", label: "dim (brightness 0.50, noise 0.07)", style: { ...DEFAULT_STYLE, brightness: 0.5, contrast: 0.8, noise: 0.07 } },
    { id: "night", label: "night (brightness 0.42, noise 0.10)", style: { ...DEFAULT_STYLE, brightness: 0.42, contrast: 0.85, noise: 0.1 } },
  ];
  type Lap = { seconds: number | null; finished: boolean; progress: number; offRoad: number; errorCamera: number; errorUsed: number };
  const lap = (driver: VisionDriver, track: (typeof suite)[number], seed: number, style?: Style): Lap => {
    let camera = 0, used = 0, count = 0;
    const result = driveEpisode(driver, {
      track, seed, styleStrength: 0, style, maxTicks, walls: true,
      onTick: (episode, d) => {
        if (episode.tick % 2 !== 0 || !d.perception) return;
        const truth = episode.truth();
        for (const c of GEOMETRY) { camera += Math.abs(d.perception.mean[c] - truth[c]); used += Math.abs(d.fused.mean[c] - truth[c]); }
        count += GEOMETRY.length;
      },
    });
    return { seconds: result.finished ? result.seconds : null, finished: result.finished, progress: result.progress, offRoad: result.offTrackShare, errorCamera: camera / Math.max(1, count), errorUsed: used / Math.max(1, count) };
  };
  const driverFor = (memory: MushroomBody | null) => new VisionDriver({ perceiver: new Perceiver(visionModel), controller: robust.clone(), domain: trackDomain, memory, fusion: { fade: 0 } });
  const rows: any[] = [];
  suite.forEach((track, index) => {
    // The same light every lap, and a control that drives after a memory of a different track.
    const memory = new MushroomBody({ seed: 11 });
    const driver = driverFor(memory);
    const laps = [lap(driver, track, 5), lap(driver, track, 5), lap(driver, track, 5)];
    const other = suite[(index + 1) % suite.length];
    const trainer = driverFor(new MushroomBody({ seed: 11 }));
    lap(trainer, other, 5);
    const wrongPlace = lap(trainer, track, 5);
    // Learn in daylight, drive in failing light: a daylight lap teaches the memory; the next lap has a dimmer, noisier camera. The control drives that lap with no memory.
    const dark: Record<string, { withMemory: Lap; withoutMemory: Lap }> = {};
    for (const light of LIGHTS) {
      const teacher = driverFor(new MushroomBody({ seed: 11 }));
      lap(teacher, track, 5);
      dark[light.id] = { withMemory: lap(teacher, track, 6, light.style), withoutMemory: lap(driverFor(null), track, 6, light.style) };
    }
    rows.push({ track: track.name, laps, wrongPlace, dark });
    const t = (l: Lap) => (l.seconds === null ? "-" : l.seconds.toFixed(1));
    console.log(`${track.id.padEnd(14)} same light: ${laps.map(t).join(" / ")} s, error camera ${laps[1].errorCamera.toFixed(3)} -> used ${laps[1].errorUsed.toFixed(3)}; wrong-track memory ${wrongPlace.errorUsed.toFixed(3)}  |  night: with ${t(dark.night.withMemory)} s ok=${dark.night.withMemory.finished} err ${dark.night.withMemory.errorCamera.toFixed(3)} -> ${dark.night.withMemory.errorUsed.toFixed(3)}; without ${t(dark.night.withoutMemory)} s ok=${dark.night.withoutMemory.finished} (${stamp()})`);
  });
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  const count = (f: (r: any) => boolean) => rows.filter(f).length;
  const finished = rows.filter((r) => r.laps[0].seconds !== null && r.laps[1].seconds !== null);
  const sameFaster = finished.filter((r) => r.laps[1].seconds < r.laps[0].seconds - 0.2).length;
  const sameBetter = count((r) => r.laps[1].errorUsed < r.laps[1].errorCamera);
  const sameGain = mean(rows.map((r) => (r.laps[1].errorCamera - r.laps[1].errorUsed) / Math.max(1e-6, r.laps[1].errorCamera)));
  const levels = LIGHTS.map((light) => {
    const w = rows.map((r) => r.dark[light.id].withMemory as Lap), wo = rows.map((r) => r.dark[light.id].withoutMemory as Lap);
    const both = rows.filter((r) => r.dark[light.id].withMemory.finished && r.dark[light.id].withoutMemory.finished);
    return {
      id: light.id, label: light.label, finishedWith: w.filter((l) => l.finished).length, finishedWithout: wo.filter((l) => l.finished).length, progressWith: mean(w.map((l) => l.progress)), progressWithout: mean(wo.map((l) => l.progress)),
      errorCamera: mean(w.map((l) => l.errorCamera)), errorUsed: mean(w.map((l) => l.errorUsed)), errorBetter: w.filter((l) => l.errorUsed < l.errorCamera).length,
      bothFinished: both.length, secondsWith: mean(both.map((r) => r.dark[light.id].withMemory.seconds)), secondsWithout: mean(both.map((r) => r.dark[light.id].withoutMemory.seconds)),
    };
  });
  const night = levels[levels.length - 1];
  results.memory = {
    description: "Vision only, no feeling channels. The Kenyon-cell memory is taught from the kart's own gyro and wheel odometry alone: at each place along the lap, where the kart was and which way it faced. From there it can recall the path ahead and turn it into the road-geometry estimates the camera also makes (heading to the look-ahead point, curvature at the look-ahead, +30 px and +150 px). Table (1): three laps in the same good light. Table (2): learn in daylight, then drive a lap with a dimmer, noisier camera, with and without the memory. Error averages the four estimates against the truth: camera alone versus what the controller used, on the same frames. The last column of table (1) is a control: the kart drives after a memory of a different track.",
    rows, levels, tracks: rows.length,
    summary: `In the same good light the memory lowered the estimate error on ${sameBetter} of ${rows.length} tracks (${(sameGain * 100).toFixed(0)}% on average) and lap 2 was faster than lap 1 on ${sameFaster} of ${finished.length} tracks finished both times: it changes little when the camera is already good. When the light fails the results are mixed (see the table); at night ${night.finishedWith} of ${rows.length} tracks were finished with the memory against ${night.finishedWithout} without, mean progress ${(night.progressWith * 100).toFixed(0)}% against ${(night.progressWithout * 100).toFixed(0)}%, and the estimate error fell from ${night.errorCamera.toFixed(3)} to ${night.errorUsed.toFixed(3)}.`,
    sameBetter, sameFaster, finishedBoth: finished.length, errorGain: sameGain, night,
  };
}

/* ---- the open world ---- */
if (only.includes("world")) {
  try {
    const worldController = SpikingNetwork.fromJSON(load(args.get("world-controller") ?? "public/vision/world-controller.json").network);
    const worldVision: VisionModel = load(args.get("world-vision") ?? "public/vision/world-vision-net.json");
    const seeds = Array.from({ length: quick ? 4 : 20 }, (_, i) => 30000 + i);
    const density = (i: number) => 0.3 + (i % 4) * 0.2;
    const rows: any[] = [];
    const add = (label: string, runs: { goals: number; crashed: boolean; collisions: number }[]) => {
      rows.push({ label, episodes: runs.length, goals: runs.reduce((s, r) => s + r.goals, 0) / runs.length, crashes: runs.filter((r) => r.crashed).length, collisions: runs.reduce((s, r) => s + r.collisions, 0) / runs.length });
      console.log(`${label.padEnd(52)} goals ${rows[rows.length - 1].goals.toFixed(2)}  crashes ${rows[rows.length - 1].crashes}/${runs.length}  collisions ${rows[rows.length - 1].collisions.toFixed(1)}  (${stamp()})`);
    };
    add("Hand-written expert (exact numbers)", seeds.map((seed, i) => runWorldEpisode("expert", { seed, density: density(i), maxTicks: 1800 })));
    const make = (perceiver: Perceiver | null, fade: number, blind = false) => new VisionDriver({ perceiver, controller: worldController.clone(), domain: worldDomain, blind, fusion: { fade } });
    add("Spiking controller · exact numbers", seeds.map((seed, i) => driveWorldEpisode(make(null, 0), { seed, density: density(i), maxTicks: 1800 })));
    add("Spiking controller · camera only", seeds.map((seed, i) => driveWorldEpisode(make(new Perceiver(worldVision), 0), { seed, density: density(i), maxTicks: 1800, styleStrength: 0.4 })));
    add("Spiking controller · camera + exact whiskers (fused)", seeds.map((seed, i) => driveWorldEpisode(make(new Perceiver(worldVision), 0.3), { seed, density: density(i), maxTicks: 1800, styleStrength: 0.4 })));
    add("Spiking controller · blind (control)", seeds.map((seed, i) => driveWorldEpisode(make(null, 0, true), { seed, density: density(i), maxTicks: 1800 })));
    results.world = { description: `${seeds.length} random worlds the networks never saw (trees, rocks, ponds, sand and mud, new colours). Goals are flags 170–390 px away, one after another, for 60 seconds. A pond ends the run; so do 8 collisions.`, rows };
  } catch (error) { console.log("world experiments skipped:", error instanceof Error ? error.message : error); }
}

/* ---- verdicts, computed from the numbers above ---- */
const gates: { id: string; title: string; status: "pass" | "partial" | "fail"; detail: string }[] = [];
try {
  const controllerRows = load("public/vision/results-controller.json").rows as any[];
  const find = (brain: string, level: string, group: string, traffic: boolean) => controllerRows.find((r) => r.brain.includes(brain) && r.level === level && r.group === group && r.traffic === traffic);
  const cleanOld = find("sample", "clean", "trained", false), cleanNew = find("controller", "clean", "trained", false), harshNew = find("controller", "brutal", "trained", false), harshOld = find("sample", "brutal", "trained", false);
  const ok = cleanNew.laps >= cleanOld.laps && harshNew.laps >= Math.ceil(harshNew.episodes * 0.7);
  gates.push({ id: "controller", title: "Controller expects imperfect eyes", status: ok ? "pass" : cleanNew.laps >= cleanOld.laps ? "partial" : "fail", detail: `Clean laps ${cleanNew.laps}/${cleanNew.episodes} (original ${cleanOld.laps}/${cleanOld.episodes}). With brutal noise and 333 ms delay: ${harshNew.laps}/${harshNew.episodes} (original ${harshOld.laps}/${harshOld.episodes}).` });
} catch { /* controller results not present */ }
if (results.closedLoop) {
  const rows: Row[] = results.closedLoop.rows; const get = (prefix: string) => rows.find((r) => r.label.startsWith(prefix))!;
  const feeling = get("Feeling only · robust"), seeing = get("Seeing only · robust"), blind = get("Blind"), faded = get("Fusion · feeling faded");
  const share = seeing.laps / Math.max(1, feeling.laps);
  gates.push({ id: "vision", title: "The camera drives on its own", status: seeing.laps >= feeling.laps - 1 && seeing.progress >= 0.85 ? "pass" : seeing.laps > blind.laps + 1 ? "partial" : "fail", detail: `Camera only: ${seeing.laps}/${seeing.episodes} laps on unseen tracks (exact numbers: ${feeling.laps}/${feeling.episodes}; blind: ${blind.laps}/${blind.episodes}). Without walls: ${seeing.strictLaps}/${seeing.episodes} vs ${feeling.strictLaps}/${feeling.episodes}.` + (share < 1 ? ` That is ${(share * 100).toFixed(0)}% of the exact-number kart’s laps.` : "") });
  gates.push({ id: "fade", title: "The feeling can be faded out", status: faded.laps >= seeing.laps ? "pass" : faded.laps >= seeing.laps - 1 ? "partial" : "fail", detail: `Feeling weight faded 1 → 0 over one lap: ${faded.laps}/${faded.episodes} laps, ${(faded.progress * 100).toFixed(0)}% progress. Averaging the two brains’ actions instead: ${get("Averaging").laps}/${get("Averaging").episodes} laps.` });
}
if (results.memory) {
  const m = results.memory; const need = Math.ceil(m.tracks * 0.6); const night = m.night;
  const helpsInTheDark = night.errorBetter >= need && night.finishedWith >= night.finishedWithout;
  const noHarm = m.sameBetter >= Math.ceil(m.tracks * 0.5) && (m.levels as any[]).every((l) => l.finishedWith >= l.finishedWithout && (l.bothFinished === 0 || l.secondsWith <= 1.1 * l.secondsWithout));
  const per = (m.levels as any[]).map((l) => `${l.id} ${l.finishedWith} vs ${l.finishedWithout} laps${l.bothFinished ? ` (${l.secondsWith.toFixed(0)} s vs ${l.secondsWithout.toFixed(0)} s where both finished)` : ""}`).join("; ");
  const detail = `${m.summary} By light, with the memory versus without: ${per}.`;
  gates.push({ id: "memory", title: "A lap teaches the kart what to expect", status: helpsInTheDark && noHarm ? "pass" : helpsInTheDark ? "partial" : "fail", detail });
}
if (results.world) {
  const rows: any[] = results.world.rows; const expert = rows.find((r) => r.label.startsWith("Hand-written"))!, feeling = rows.find((r) => r.label.startsWith("Spiking controller · exact"))!, seeing = rows.find((r) => r.label.includes("camera only"))!;
  gates.push({ id: "world", title: "The same logic drives an open world", status: seeing.goals >= 0.75 * feeling.goals && seeing.crashes <= feeling.crashes + 3 ? "pass" : seeing.goals >= 0.5 * feeling.goals ? "partial" : "fail", detail: `Camera only: ${seeing.goals.toFixed(2)} goals per run and ${seeing.crashes}/${seeing.episodes} crashes, against ${feeling.goals.toFixed(2)} and ${feeling.crashes}/${feeling.episodes} for the same spiking controller on exact numbers. The hand-written expert reaches ${expert.goals.toFixed(2)} goals with ${expert.crashes}/${expert.episodes} crashes, so the spiking controller itself is the weaker part here, not the eyes.` });
}
results.gates = gates;
writeFileSync(out, JSON.stringify(results, null, 1));
console.log("wrote", out, stamp());
