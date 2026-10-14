// Browser worker: evaluates one brain on a list of trials and replies with the outcomes. No DOM, no rendering.
import { runCases } from "./cases";
import type { WorkerJob, WorkerReply } from "./backend";

self.onmessage = (event: MessageEvent<WorkerJob>) => {
  const job = event.data;
  try {
    const reply: WorkerReply = { id: job.id, outcomes: runCases(job.brain, job.cases) };
    (self as unknown as Worker).postMessage(reply);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply);
  }
};
