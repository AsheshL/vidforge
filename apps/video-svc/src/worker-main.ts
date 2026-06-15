import { startWorker } from "./worker.js";

const worker = startWorker();

// ECS sends SIGTERM on deploy/scale-in; close() waits for the in-flight
// job to finish (or be requeued) before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining worker`);
    void worker.close().then(() => process.exit(0));
  });
}
