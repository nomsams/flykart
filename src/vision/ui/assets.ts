// The trained networks and measurements that ship with the page (public/vision/*.json).
import { BrainSnapshot } from "../../core";
import { parseBrainFile } from "../../lab";
import type { VisionModel } from "../perception";

export type Assets = {
  /** The controller evolved to cope with imperfect eyes. */
  robust: BrainSnapshot | null;
  /** The original FlyKart demo brain (trained on exact numbers only). */
  v1: BrainSnapshot | null;
  vision: VisionModel | null;
  worldController: BrainSnapshot | null;
  worldVision: VisionModel | null;
  /** Experiment results written by `npm run vision:experiments`. */
  results: Record<string, any> | null;
  controllerResults: Record<string, any> | null;
};

const base = (): string => import.meta.env.BASE_URL ?? "./";

/** A file that is not there comes back as the app's HTML page under Vite, so anything that is not JSON counts as missing. */
async function fetchText(path: string, problems: string[]): Promise<string | null> {
  try {
    const response = await fetch(`${base()}${path}`);
    const text = await response.text();
    if (!response.ok || text.trimStart().startsWith("<")) { problems.push(path); return null; }
    return text;
  } catch { problems.push(path); return null; }
}

async function fetchJson<T>(path: string, problems: string[]): Promise<T | null> {
  const text = await fetchText(path, problems);
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { problems.push(path); return null; }
}

async function brain(path: string, problems: string[]): Promise<BrainSnapshot | null> {
  const text = await fetchText(path, problems);
  if (text === null) return null;
  try { return parseBrainFile(text).snapshot; } catch { problems.push(path); return null; }
}

export async function loadAssets(): Promise<{ assets: Assets; problems: string[] }> {
  const problems: string[] = [];
  const [robust, v1, vision, worldController, worldVision, results, controllerResults] = await Promise.all([
    brain("vision/controller.json", problems), brain("sample-brain.json", problems), fetchJson<VisionModel>("vision/vision-net.json", problems),
    brain("vision/world-controller.json", problems), fetchJson<VisionModel>("vision/world-vision-net.json", problems),
    fetchJson<Record<string, any>>("vision/results.json", problems), fetchJson<Record<string, any>>("vision/results-controller.json", problems),
  ]);
  return { assets: { robust, v1, vision, worldController, worldVision, results, controllerResults }, problems };
}
