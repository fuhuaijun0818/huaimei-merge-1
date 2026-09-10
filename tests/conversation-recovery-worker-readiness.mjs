import assert from "node:assert/strict";

import { createObservability } from "../server/observability/index.mjs";
import { startObservabilityServer } from "../server/observability-server.mjs";
import {
  conversationRecoveryReadiness,
  createConversationReceiptRecoveryWorker,
  superviseConversationRecoveryRuntime
} from "../server/workers/conversation-receipt-recovery-worker.mjs";

const waitFor = async (check, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for conversation recovery worker state");
};

const logLines = [];
const observability = createObservability({
  service:"huamei-conversation-recovery-test",
  environment:"test",
  write:(line) => logLines.push(String(line))
});
let calls = 0;
let permanentFailure = false;
const secretDatabaseMessage = "postgresql://runtime:must-not-leak@db.internal/huamei";
const runPass = async () => {
  calls += 1;
  if (calls === 1 || permanentFailure) {
    const error = new Error(secretDatabaseMessage);
    error.code = permanentFailure ? "RECOVERY_DATABASE_FATAL" : "RECOVERY_DATABASE_TRANSIENT";
    throw error;
  }
  return { status:"ok", tenant_count:1, failed_receipts:0, receipts:[] };
};
const worker = createConversationReceiptRecoveryWorker({
  runPass,
  intervalMs:10,
  maximumConsecutiveFailures:3,
  observability
});
const metricsToken = "conversation-recovery-test-token-not-printed";
const databaseHealth = { ok:true, status:"ok" };
const runtime = await startObservabilityServer({
  observability,
  environment:"test",
  token:metricsToken,
  host:"127.0.0.1",
  port:0,
  readiness:async () => conversationRecoveryReadiness(databaseHealth, worker.metrics(), {
    maximumSuccessAgeMs:1_000
  })
});
const ready = () => fetch(`http://127.0.0.1:${runtime.port}/readyz`, {
  headers:{ "X-Metrics-Token":metricsToken }
});

try {
  assert.equal((await ready()).status, 503, "首次成功pass前不得ready");
  worker.start();
  await waitFor(async () => (await ready()).status === 200);
  assert.ok(calls >= 2, "一次瞬态失败后必须自动恢复并重新ready");
  assert.equal(logLines.join("\n").includes(secretDatabaseMessage), false, "恢复日志不得包含数据库错误原文");

  permanentFailure = true;
  let terminalCleanupSignal = null;
  await assert.rejects(
    superviseConversationRecoveryRuntime({
      worker,
      signalPromise:new Promise(() => {}),
      shutdown:async (signal) => {
        terminalCleanupSignal = signal;
        await worker.stop();
      }
    }),
    (error) => error?.code === "RECOVERY_DATABASE_FATAL",
    "连续持久失败必须传播到进程监督器"
  );
  assert.equal(terminalCleanupSignal, "CONVERSATION_RECOVERY_TERMINAL");
  const failed = await ready();
  assert.equal(failed.status, 503, "终止错误后readyz必须失败");
  const failedBody = await failed.json();
  assert.deepEqual(failedBody.checks.conversation_recovery, { ok:false, status:"failed" });
  assert.equal(JSON.stringify(failedBody).includes(secretDatabaseMessage), false);
  assert.equal(logLines.join("\n").includes(secretDatabaseMessage), false);
} finally {
  await worker.stop();
  await new Promise((resolve) => runtime.server.close(resolve));
}

let passStarted;
let finishPass;
const started = new Promise((resolve) => { passStarted = resolve; });
const finish = new Promise((resolve) => { finishPass = resolve; });
const drainWorker = createConversationReceiptRecoveryWorker({
  runPass:async () => {
    passStarted();
    await finish;
    return { status:"ok", tenant_count:1, failed_receipts:0, receipts:[] };
  },
  intervalMs:10,
  maximumConsecutiveFailures:3,
  observability:createObservability({ service:"huamei-conversation-recovery-drain-test", environment:"test", write:() => {} })
});
drainWorker.start();
await started;
let drained = false;
const stopping = drainWorker.stop().then(() => { drained = true; });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(drained, false, "SIGTERM停止必须等待当前恢复pass完成");
finishPass();
await stopping;
assert.equal(drained, true);

console.log("✓ 会话恢复worker瞬态恢复、连续失败非零传播、readyz、脱敏日志与SIGTERM drain通过");
