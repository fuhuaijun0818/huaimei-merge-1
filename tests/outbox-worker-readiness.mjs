import assert from "node:assert/strict";

import { createObservability } from "../server/observability/index.mjs";
import { startObservabilityServer } from "../server/observability-server.mjs";
import {
  createPostgresOutboxWorker,
  outboxWorkerReadiness,
  superviseOutboxRuntime
} from "../server/workers/postgres-outbox-worker.mjs";

let failLoop = false;
const emptyMetrics = {
  pending:0,
  retry:0,
  processing:0,
  published:0,
  deadLetter:0,
  ready:0,
  expiredLeases:0,
  backlog:0,
  oldestBacklogSeconds:0
};
const store = {
  claimBatch:async () => {
    if (failLoop) {
      const error = new Error("sensitive database detail must not reach readiness");
      error.code = "OUTBOX_WORKER_FATAL";
      error.fatal = true;
      throw error;
    }
    return [];
  },
  metrics:async () => ({ ...emptyMetrics }),
  renewLease:async () => true,
  markPublished:async () => true,
  markFailed:async () => ({ status:"retry" })
};
const observability = createObservability({
  service:"huamei-outbox-readiness-test",
  environment:"test",
  write:() => {}
});
const worker = createPostgresOutboxWorker({
  store,
  tenantIds:["huamei-shanghai"],
  publish:async () => ({ status:200 }),
  observability,
  pollIntervalMs:10
});
const databaseHealth = { ok:true, status:"ok" };
const metricsToken = "outbox-readiness-token-not-printed";
const runtime = await startObservabilityServer({
  observability,
  environment:"test",
  token:metricsToken,
  host:"127.0.0.1",
  port:0,
  readiness:async () => outboxWorkerReadiness(databaseHealth, await worker.metrics())
});
const baseUrl = `http://127.0.0.1:${runtime.port}`;
const ready = () => fetch(`${baseUrl}/readyz`, { headers:{ "X-Metrics-Token":metricsToken } });

try {
  const starting = await ready();
  assert.equal(starting.status, 503, "worker.start前启动窗口必须not ready");
  const startingBody = await starting.json();
  assert.equal(startingBody.checks.postgres.ok, true);
  assert.deepEqual(startingBody.checks.outbox_worker, { ok:false, status:"not_running" });

  worker.start();
  const running = await ready();
  assert.equal(running.status, 200);
  const runningBody = await running.json();
  assert.deepEqual(runningBody.checks.outbox_worker, { ok:true, status:"running" });

  failLoop = true;
  let terminalShutdownSignal = null;
  await assert.rejects(
    superviseOutboxRuntime({
      worker,
      signalPromise:new Promise(() => {}),
      shutdown:async (signal) => {
        terminalShutdownSignal = signal;
        await worker.stop();
      }
    }),
    (error) => error?.code === "OUTBOX_WORKER_FATAL",
    "worker终止性错误必须传播给进程监督器"
  );
  assert.equal(terminalShutdownSignal, "OUTBOX_WORKER_TERMINAL", "终止性错误必须触发资源清理后让进程非零退出");
  const failed = await ready();
  assert.equal(failed.status, 503, "处理循环异常退出后readiness必须失败");
  const failedBody = await failed.json();
  assert.deepEqual(failedBody.checks.outbox_worker, { ok:false, status:"failed" });
  assert.equal(JSON.stringify(failedBody).includes("sensitive database detail"), false);
  const failedMetrics = await worker.metrics();
  assert.equal(failedMetrics.running, false);
  assert.equal(failedMetrics.terminalErrorCode, "OUTBOX_WORKER_FATAL");
} finally {
  await worker.stop();
  await new Promise((resolve) => runtime.server.close(resolve));
}

console.log("✓ Outbox启动窗口、终止错误传播/清理、running/stopping门禁与readiness=503通过");
