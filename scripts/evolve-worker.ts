// Worker thread for the overnight runner: evaluates one brain on a list of trials and answers with the outcomes.
import { parentPort } from "node:worker_threads";
import { runCases } from "../src/evolve/cases";
import type { WorkerJob, WorkerReply } from "../src/evolve/backend";

parentPort!.on("message", (job: WorkerJob) => {
  try {
    const reply: WorkerReply = { id: job.id, outcomes: runCases(job.brain, job.cases) };
    parentPort!.postMessage(reply);
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply);
  }
});
