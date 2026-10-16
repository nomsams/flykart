// Evaluation backends: where the trials actually run.
import type { BrainSnapshot } from "../core";
import { runCases, type CaseOutcome, type CaseSpec } from "./cases";
import type { EvalBackend } from "./engine";

/** Runs everything on the calling thread. Used by tests and as the fallback when workers are unavailable. */
export class InlineBackend implements EvalBackend {
  readonly size = 1;
  async evaluate(brains: BrainSnapshot[], cases: CaseSpec[]): Promise<CaseOutcome[][]> {
    const out: CaseOutcome[][] = [];
    for (const brain of brains) { out.push(runCases(brain, cases)); await Promise.resolve(); }
    return out;
  }
}

/** A message a worker answers: the outcomes of one brain on a list of cases. */
export type WorkerJob = { id: number; brain: BrainSnapshot; cases: CaseSpec[] };
export type WorkerReply = { id: number; outcomes?: CaseOutcome[]; error?: string };

/**
 * A pool over any message-passing workers (Web Workers in the browser, worker_threads in Node). `spawn` returns a
 * handle with postMessage / onmessage-style hooks so this file needs neither environment's types.
 */
export type WorkerHandle = { post(job: WorkerJob): void; onReply(listener: (reply: WorkerReply) => void): void; terminate(): void };

export class PoolBackend implements EvalBackend {
  private readonly idle: WorkerHandle[] = [];
  private readonly queue: { job: WorkerJob; resolve: (o: CaseOutcome[]) => void; reject: (e: Error) => void }[] = [];
  private readonly busy = new Map<WorkerHandle, { id: number; resolve: (o: CaseOutcome[]) => void; reject: (e: Error) => void }>();
  private sequence = 1;
  readonly size: number;

  constructor(private readonly workers: WorkerHandle[]) {
    this.size = workers.length;
    for (const w of workers) {
      this.idle.push(w);
      w.onReply((reply) => {
        const task = this.busy.get(w);
        if (!task) return; // nothing was asked of this worker: a stray message must not put it in the idle list twice
        this.busy.delete(w); this.idle.push(w);
        if (reply.error) task.reject(new Error(reply.error));
        else if (reply.id === task.id) task.resolve(reply.outcomes ?? []);
        else task.reject(new Error("A worker answered a different job than the one it was given."));
        this.pump();
      });
    }
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!, task = this.queue.shift()!;
      this.busy.set(worker, { id: task.job.id, resolve: task.resolve, reject: task.reject });
      worker.post(task.job);
    }
  }

  evaluate(brains: BrainSnapshot[], cases: CaseSpec[]): Promise<CaseOutcome[][]> {
    return Promise.all(brains.map((brain) => new Promise<CaseOutcome[]>((resolve, reject) => {
      this.queue.push({ job: { id: this.sequence++, brain, cases }, resolve, reject });
      this.pump();
    })));
  }

  close(): void { for (const w of this.workers) w.terminate(); }
}
