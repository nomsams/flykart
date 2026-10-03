// Collecting training data for the camera network, DAgger style.
//
// A teacher that sees exact numbers (the "feeling" controller) drives, and a
// shadow copy of it labels every frame with what it would do. In later rounds
// the *student* (camera -> estimates -> controller) drives instead, and the
// teacher keeps labelling. Training on the states the student actually visits,
// not just the ones the teacher would, is what stops small errors from
// compounding into a crash (Ross, Gordon & Bagnell, 2011).
import { Action, SpikingNetwork, TrackRef, nearestTrack, pointAtDistance, resolveTrack } from "../core";
import type { Domain, VisionEpisode } from "./domain";
import { TrackEpisode } from "./episode";
import { sensorsFromEstimates } from "./interface";
import { Perceiver, VISION_STRIDE, FRAME_LAG } from "./perception";
import { VisionDriver } from "./pipeline";
import { VisionDataset } from "./train";
import { Random, gaussian, mulberry32, pick } from "./rng";
import { WorldEpisode, worldDomain } from "./world/worldDomain";
import { surfaceAt } from "./world/world";

export type EpisodeSetup = { episode: VisionEpisode; group: number; label: string; fromStart: boolean };

export type CollectSettings = {
  domain: Domain;
  episodes: number; ticks: number; seed: number;
  /** Build an episode. `student` says whether the camera pipeline will drive it. */
  newEpisode: (index: number, random: Random, student: boolean) => EpisodeSetup;
  /** The privileged controller. Only its weights are used; a fresh copy is made. */
  teacher: SpikingNetwork;
  perceiver: Perceiver | null;
  /** Probability that an episode is driven by the camera pipeline (only if a perceiver is given). */
  studentShare: number;
  /** Of the student's episodes, how many hand control to the teacher for stretches. */
  mixedShare: number;
  /** Steering noise (std) injected into teacher-driven episodes so they leave the ideal line. */
  dart: number;
  dataset: VisionDataset;
  onEpisode?: (index: number, summary: EpisodeLog) => void;
};

export type EpisodeLog = { label: string; driver: "teacher" | "student" | "mixed"; fromStart: boolean; ticks: number; progress: number; finished: boolean; crashed: boolean; samples: number };
export type CollectStats = { episodes: number; samples: number; student: { episodes: number; startEpisodes: number; meanProgress: number; laps: number; crashes: number }; logs: EpisodeLog[] };

/** Random track episodes with varied traffic, start points and looks. */
export function trackFactory(tracks: TrackRef[], groupOf: (track: TrackRef) => number, options: { trafficShare?: number; styleStrength?: number; physicsVariation?: number; ticks: number }) {
  return (_index: number, random: Random, student: boolean): EpisodeSetup => {
    const track = pick(random, tracks);
    const traffic = random() < (options.trafficShare ?? 0.5);
    const fromStart = student ? random() < 0.5 : random() < 0.3;
    const episode = new TrackEpisode({
      track, rivals: traffic ? 1 + Math.floor(random() * 2) : 0, roadObjects: traffic ? Math.floor(random() * 4) : 0, objectKind: "mixed",
      seed: Math.floor(random() * 1e6) + 1, styleStrength: options.styleStrength ?? 1, physicsVariation: random() < 0.4 ? options.physicsVariation ?? 0.1 : 0, maxTicks: options.ticks + 200,
    });
    if (!fromStart) episode.placeAt({ distance: random() * episode.route.length, lateral: (random() * 2 - 1) * 0.55, headingOffset: gaussian(random) * 0.18, speed: 20 + random() * 50 });
    return { episode, group: groupOf(track), label: episode.route.id, fromStart };
  };
}

/** Random open-world episodes: new terrain, obstacles and palette every time. */
export function worldFactory(options: { seeds: () => number; styleStrength?: number; ticks: number; densityRange?: [number, number] }) {
  return (_index: number, random: Random): EpisodeSetup => {
    const seed = options.seeds();
    const [low, high] = options.densityRange ?? [0.25, 0.9];
    const episode = new WorldEpisode({ seed, density: low + random() * (high - low), styleStrength: options.styleStrength ?? 1, maxTicks: options.ticks + 200 });
    return { episode, group: seed % 1000, label: `world ${seed}`, fromStart: true };
  };
}

export type BurstSettings = {
  tracks: TrackRef[]; groupOf: (track: TrackRef) => number;
  bursts: number; seed: number;
  teacher: SpikingNetwork;
  dataset: VisionDataset;
  styleStrength?: number;
};

/**
 * Many short scenes, each with a fresh arrangement of karts and obstacles a
 * short way ahead, and only a few frames from each. A camera network learns to
 * see a cone from hundreds of different cones, not from one cone watched for
 * a hundred frames: long episodes contain few distinct objects.
 */
export function collectTrafficBursts(settings: BurstSettings): number {
  const random = mulberry32(settings.seed);
  const { dataset } = settings; const teacher = settings.teacher.clone();
  const body = new Float32Array(3); const label = new Float32Array(3);
  let made = 0;
  for (let burst = 0; burst < settings.bursts && dataset.size + 3 <= dataset.capacity; burst += 1) {
    const track = pick(random, settings.tracks); const route = resolveTrack(track);
    const episode = new TrackEpisode({
      track, rivals: pick(random, [0, 1, 1, 2]), roadObjects: pick(random, [1, 1, 2, 3]), objectKind: pick(random, ["mixed", "cone", "stalled-car", "barrier", "cone", "stalled-car"] as const),
      seed: Math.floor(random() * 1e6) + 1, styleStrength: settings.styleStrength ?? 1, maxTicks: 40,
    });
    const at = random() * route.length;
    episode.placeAt({ distance: at, lateral: (random() * 2 - 1) * 0.5, headingOffset: gaussian(random) * 0.15, speed: 20 + random() * 50 });
    const arrange = (car: { position: { x: number; y: number }; heading: number; speed: number; progress: number; distanceAlong: number }, rival: boolean): void => {
      const ahead = pointAtDistance(at + 30 + random() * 150, route); const normal = { x: -ahead.tangent.y, y: ahead.tangent.x };
      const offset = (random() * 2 - 1) * 0.65 * route.width / 2;
      car.position = { x: ahead.point.x + normal.x * offset, y: ahead.point.y + normal.y * offset };
      if (rival) { car.heading = Math.atan2(ahead.tangent.y, ahead.tangent.x) + gaussian(random) * 0.1; car.speed = 15 + random() * 45; }
      const near = nearestTrack(car.position, route); car.progress = near.progress; car.distanceAlong = near.distanceAlong;
    };
    episode.rivals.forEach((car) => arrange(car, true));
    episode.roadObjects.forEach((car) => arrange(car, false));
    teacher.reset();
    const starts: number[] = [];
    for (let tick = 0; tick <= 8; tick += 1) {
      const truth = episode.truth();
      const action = teacher.step(trackDomainSensors(truth, episode));
      if (tick % VISION_STRIDE === 0 && tick >= 4) {
        const b = episode.proprioception(); body[0] = b.speed; body[1] = b.lastSteer; body[2] = b.lastDrive;
        label[0] = action.steer; label[1] = action.throttle - action.brake; label[2] = action.reverse ?? 0;
        starts.push(dataset.add(episode.render(), starts.length >= FRAME_LAG ? starts[starts.length - FRAME_LAG] : -1, body, truth, label, 1_000_000 + burst, settings.groupOf(track))); made += 1;
      }
      episode.step(action);
    }
  }
  return made;
}

export type WorldBurstSettings = { bursts: number; seed: number; teacher: SpikingNetwork; dataset: VisionDataset; styleStrength?: number };

/**
 * Short scenes in fresh worlds with the kart a short way from a pond or an obstacle and roughly facing it, so the
 * camera network meets hundreds of different ponds, trees and rocks at every distance instead of the few a long drive passes.
 */
export function collectWorldBursts(settings: WorldBurstSettings): number {
  const random = mulberry32(settings.seed); const { dataset } = settings; const teacher = settings.teacher.clone();
  const body = new Float32Array(3); const label = new Float32Array(3);
  let made = 0;
  for (let burst = 0; burst < settings.bursts && dataset.size + 3 <= dataset.capacity; burst += 1) {
    const episode = new WorldEpisode({ seed: 500000 + Math.floor(random() * 1e6), density: 0.3 + random() * 0.65, styleStrength: settings.styleStrength ?? 1, maxTicks: 40 });
    const { world, kart } = episode.sim;
    const ponds = world.patches.filter((p) => p.kind === "water");
    const targets: { x: number; y: number; radius: number }[] = random() < 0.5 && ponds.length > 0 ? ponds : [...world.obstacles, ...ponds];
    if (targets.length === 0) continue;
    const target = targets[Math.floor(random() * targets.length)];
    const angle = random() * Math.PI * 2; const distance = target.radius + 35 + random() * 170;
    kart.x = target.x + Math.cos(angle) * distance; kart.y = target.y + Math.sin(angle) * distance;
    kart.heading = angle + Math.PI + (random() - 0.5) * 1.0; kart.speed = 20 + random() * 40;
    if (Math.abs(kart.x) > world.half - 30 || Math.abs(kart.y) > world.half - 30) continue;
    if (surfaceAt(world, kart.x, kart.y) === "water" || world.obstacles.some((o) => Math.hypot(o.x - kart.x, o.y - kart.y) < o.radius + 14)) continue;
    teacher.reset();
    const starts: number[] = [];
    for (let tick = 0; tick <= 8; tick += 1) {
      const truth = episode.truth();
      const action = teacher.step(worldDomain.sensors(truth, episode.mission(), episode.proprioception()));
      if (tick % VISION_STRIDE === 0 && tick >= 4) {
        const b = episode.proprioception(); body[0] = b.speed; body[1] = b.lastSteer; body[2] = b.lastDrive;
        label[0] = action.steer; label[1] = action.throttle - action.brake; label[2] = action.reverse ?? 0;
        starts.push(dataset.add(episode.render(), starts.length >= FRAME_LAG ? starts[starts.length - FRAME_LAG] : -1, body, truth, label, 2_000_000 + burst, 0)); made += 1;
      }
      episode.step(action);
    }
  }
  return made;
}

function trackDomainSensors(truth: number[], episode: TrackEpisode): number[] { return sensorsFromEstimates(truth, episode.proprioception()); }

export function collect(settings: CollectSettings): CollectStats {
  const random = mulberry32(settings.seed);
  const { dataset, domain } = settings;
  const logs: EpisodeLog[] = [];
  const teacher = settings.teacher.clone();
  const student = settings.teacher.clone();
  let episodeNumber = 0;
  for (let n = 0; n < settings.episodes && !dataset.full; n += 1) {
    const useStudent = settings.perceiver !== null && random() < settings.studentShare;
    const mixed = useStudent && random() < settings.mixedShare;
    const { episode, group, label, fromStart } = settings.newEpisode(n, random, useStudent);
    teacher.reset(); student.reset();
    const driver = useStudent && settings.perceiver ? new VisionDriver({ perceiver: settings.perceiver, controller: student, domain, fusion: { fade: 0 } }) : null;
    driver?.reset();
    let dart = 0; let handover = 0; let teacherHasWheel = !useStudent || mixed;
    const sampleStarts: number[] = []; // dataset index of each vision step in this episode, to find the frame one lag earlier
    const body = new Float32Array(3); const label3 = new Float32Array(3);
    const startSamples = dataset.size;
    for (let tick = 0; tick < settings.ticks && !episode.done && !dataset.full; tick += 1) {
      const truth = episode.truth();
      const teacherAction = teacher.step(domain.sensors(truth, episode.mission(), episode.proprioception()));
      let action: Action = teacherAction;
      const visionStep = tick % VISION_STRIDE === 0;
      if (driver) {
        const frame = driver.act(episode);
        if (mixed) {
          if (handover <= 0) { teacherHasWheel = random() < 0.5; handover = 40 + Math.floor(random() * 60); }
          handover -= 1;
        } else teacherHasWheel = false;
        action = teacherHasWheel ? teacherAction : frame.action;
      } else {
        dart = dart * 0.93 + gaussian(random) * settings.dart * 0.37;
        action = { ...teacherAction, steer: Math.max(-1, Math.min(1, teacherAction.steer + dart)) };
      }
      if (visionStep) {
        const image = driver ? episode.frame : episode.render();
        const bodyState = episode.proprioception(); body[0] = bodyState.speed; body[1] = bodyState.lastSteer; body[2] = bodyState.lastDrive;
        label3[0] = teacherAction.steer; label3[1] = teacherAction.throttle - teacherAction.brake; label3[2] = teacherAction.reverse ?? 0;
        const earlier = sampleStarts.length >= FRAME_LAG ? sampleStarts[sampleStarts.length - FRAME_LAG] : -1;
        sampleStarts.push(dataset.add(image, earlier, body, truth, label3, episodeNumber, group));
      }
      episode.step(action);
    }
    const summary = episode.summary();
    const log: EpisodeLog = { label, driver: useStudent ? (mixed ? "mixed" : "student") : "teacher", fromStart, ticks: episode.tick, progress: summary.progress, finished: summary.finished, crashed: summary.crashed, samples: dataset.size - startSamples };
    logs.push(log); settings.onEpisode?.(n, log); episodeNumber += 1;
  }
  const students = logs.filter((log) => log.driver === "student");
  const fromStart = students.filter((log) => log.fromStart);
  return {
    episodes: logs.length, samples: dataset.size, logs,
    student: { episodes: students.length, startEpisodes: fromStart.length, meanProgress: fromStart.reduce((s, l) => s + l.progress, 0) / Math.max(1, fromStart.length), laps: fromStart.filter((l) => l.finished).length, crashes: students.filter((l) => l.crashed).length },
  };
}
