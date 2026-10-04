// A tiny worker pool for the training scripts. The worker file is bundled with
// esbuild on the fly (workers cannot import TypeScript directly), so the same
// simulator code runs in every thread.
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cpus } from "node:os";

export async function bundleWorker(entry: string, name: string): Promise<string> {
  mkdirSync(resolve(".cache"), { recursive: true });
  const outfile = resolve(".cache", `${name}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent", target: "node20" });
  return outfile;
}

type Job = { message: unknown; resolve: (value: any) => void; reject: (error: Error) => void };

export class Pool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly current = new Map<Worker, Job>();

  private constructor(file: string, size: number) {
    for (let i = 0; i < size; i += 1) {
      const worker = new Worker(file);
      worker.on("message", (value) => { const job = this.current.get(worker); this.current.delete(worker); this.idle.push(worker); job?.resolve(value); this.pump(); });
      worker.on("error", (error) => { const job = this.current.get(worker); this.current.delete(worker); job?.reject(error); });
      this.workers.push(worker); this.idle.push(worker);
    }
  }

  static async create(entry: string, name: string, size = Math.max(1, Math.min(cpus().length - 1, 3))): Promise<Pool> {
    return new Pool(await bundleWorker(entry, name), size);
  }

  get size(): number { return this.workers.length; }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!; const job = this.queue.shift()!;
      this.current.set(worker, job); worker.postMessage(job.message);
    }
  }

  run<T>(message: unknown): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => { this.queue.push({ message, resolve: resolvePromise, reject }); this.pump(); });
  }

  async close(): Promise<void> { await Promise.all(this.workers.map((worker) => worker.terminate())); }
}
