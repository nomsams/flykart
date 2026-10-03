import { Action, BrainSnapshot, SpikingNetwork } from "../core";
import type { Pose } from "./model";

export type TrainingOptions = { evolve: boolean; seconds: number; episodes: number; population: number; generations: number; seed: number; rate: number; amount: number };
export type EpisodeStep = { time: number; inputs: number[]; action: Action; pwm: number[]; cameraFrame: number; sonar: { cm: number | null; echo: boolean }; evaluation: { pose: Pose; blocked: boolean; contact: string | null; surface: string | null } };
export type EpisodeSummary = { generation: number; candidate: number; episode: number; score: number; seconds: number; distance: number; cells: number; contacts: number; blockedSeconds: number; cableSeconds: number };
export type EpisodeDataset = { summary: EpisodeSummary; steps: EpisodeStep[]; frames: { id: number; width: number; height: number; encoding: "planar-rgb8-base64"; pixels: string; dropped: boolean }[]; omittedFrames: number };

export class EpisodeRecorder {
  readonly steps: EpisodeStep[] = []; readonly frames: EpisodeDataset["frames"] = []; readonly cells = new Set<string>();
  distance = 0; contacts = 0; blockedSeconds = 0; cableSeconds = 0; seconds = 0; omittedFrames = 0;
  private previous: Pose | null = null; private blocked = false; private bytes = 0;
  frame(id: number, width: number, height: number, planar: Float32Array, dropped: boolean): void {
    if (this.bytes + planar.length > 6_000_000) { this.omittedFrames++; return; }
    this.bytes += planar.length;
    let binary = ""; for (const value of planar) binary += String.fromCharCode(Math.round(Math.max(0, Math.min(1, value)) * 255));
    this.frames.push({ id, width, height, encoding: "planar-rgb8-base64", pixels: btoa(binary), dropped });
  }
  step(step: EpisodeStep, dt: number): void {
    if (this.steps.length >= 1801) return;
    const p = step.evaluation.pose;
    if (this.previous) this.distance += Math.hypot(p.x - this.previous.x, p.z - this.previous.z);
    this.previous = { ...p }; this.cells.add(`${Math.floor(p.x / .2)},${Math.floor(p.z / .2)}`);
    if (step.evaluation.blocked && !this.blocked) this.contacts++;
    this.blocked = step.evaluation.blocked; this.blockedSeconds += +this.blocked * dt; this.cableSeconds += +(step.evaluation.surface === "cable") * dt;
    this.seconds += dt; this.steps.push(structuredClone(step));
  }
  finish(generation: number, candidate: number, episode: number): EpisodeDataset {
    const score = (this.cells.size - 1) * .5 + Math.min(this.distance, this.cells.size * .4) - this.contacts * 2 - this.blockedSeconds - this.cableSeconds * .1;
    return { summary: { generation, candidate, episode, score, seconds: this.seconds, distance: this.distance, cells: this.cells.size, contacts: this.contacts, blockedSeconds: this.blockedSeconds, cableSeconds: this.cableSeconds }, steps: this.steps, frames: this.frames, omittedFrames: this.omittedFrames };
  }
}

/** Sequential, seeded evaluations through the real 3D camera and controller loop. */
export class TrainingRun {
  generation = 1; candidate = 0; episode = 0; completed = false; recorder = new EpisodeRecorder();
  readonly results: EpisodeSummary[] = []; readonly datasets: EpisodeDataset[] = [];
  fitness = 0; completedGeneration = 0;
  private parent: SpikingNetwork; private candidates: SpikingNetwork[] = []; private scores: number[] = [];
  constructor(brain: SpikingNetwork, readonly options: TrainingOptions) {
    if (!Number.isFinite(options.seed) || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647 || !Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 60 || !Number.isInteger(options.episodes) || options.episodes < 1 || options.episodes > 5 || !Number.isInteger(options.population) || options.population < 2 || options.population > 8 || !Number.isInteger(options.generations) || options.generations < 1 || options.generations > 10 || !Number.isFinite(options.rate) || options.rate < 0 || options.rate > 1 || !Number.isFinite(options.amount) || options.amount < 0 || options.amount > 1) throw new Error("Training settings are outside the supported limits.");
    this.parent = brain.clone(); this.makeGeneration();
  }
  private makeGeneration(): void {
    this.candidates = [this.parent.clone()];
    if (this.options.evolve) for (let i = 1; i < this.options.population; i++) this.candidates.push(this.parent.mutate(this.options.rate, this.options.amount, this.options.seed + this.generation * 1000 + i));
    this.scores = this.candidates.map(() => 0);
  }
  get brain(): SpikingNetwork { return this.candidates[this.candidate].clone(); }
  get best(): BrainSnapshot { return this.parent.toJSON(); }
  get noiseSeed(): number { return (this.options.seed + this.episode) % 2147483647; }
  get progress(): string { return `Generation ${this.generation}/${this.options.evolve ? this.options.generations : 1} · candidate ${this.candidate + 1}/${this.candidates.length} · episode ${this.episode + 1}/${this.options.episodes} · ${this.recorder.seconds.toFixed(1)}/${this.options.seconds}s`; }
  advance(): boolean {
    if(this.completed)throw new Error("This training run has finished.");
    const data = this.recorder.finish(this.generation, this.candidate, this.episode + 1); this.results.push(data.summary); this.scores[this.candidate] += data.summary.score / this.options.episodes;
    this.datasets.push(data); if (this.datasets.length > 2) this.datasets.shift();
    this.recorder = new EpisodeRecorder(); this.episode++;
    if (this.episode < this.options.episodes) return true;
    this.episode = 0; this.candidate++;
    if (this.candidate < this.candidates.length) return true;
    const winner = this.scores.indexOf(Math.max(...this.scores)); this.parent = this.candidates[winner].clone();this.fitness=this.scores[winner];this.completedGeneration=this.generation;
    if (!this.options.evolve || this.generation >= this.options.generations) { this.completed = true; return false; }
    this.generation++; this.candidate = 0; this.makeGeneration(); return true;
  }
}
