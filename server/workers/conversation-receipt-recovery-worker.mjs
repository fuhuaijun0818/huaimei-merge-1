import { pathToFileURL } from "node:url";

import { getPostgresAcquisitionSessionStore } from "../persistence/postgres-session-store.mjs";
import { closePostgresClient, getPostgresClient } from "../platform/postgres.mjs";
import { normalizeTenantId } from "../platform/tenant-context.mjs";
import { getObservability } from "../observability/index.mjs";
import { startObservabilityServer } from "../observability-server.mjs";

const positiveInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
};

const sleep = (milliseconds, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once:true });
});

const safeRecoveryErrorCode = (error) => {
  const code = String(error?.code || "CONVERSATION_RECOVERY_PASS_FAILED").trim().toUpperCase();
  return /^[A-Z0-9_.:-]{2,96}$/.test(code) ? code : "CONVERSATION_RECOVERY_PASS_FAILED";
};

export const configuredRecoveryTenants = (env = process.env) => [...new Set(String(
  env.HUAMEI_CONVERSATION_RECOVERY_TENANT_IDS
    || env.HUAMEI_RECOVERY_TENANT_IDS
    || env.HUAMEI_DEFAULT_TENANT_ID
    || "huamei-shanghai"
).split(",").map((value) => value.trim()).filter(Boolean).map((value) => normalizeTenantId(value)))];

export async function runConversationReceiptRecoveryPass(options = {}) {
  const store = options.store || getPostgresAcquisitionSessionStore();
  const tenants = options.tenantIds || configuredRecoveryTenants(options.env || process.env);
  const now = options.now || new Date().toISOString();
  const limitPerTenant = positiveInteger(options.limitPerTenant, 100, 1, 500);
  const results = [];
  for (const tenantId of tenants) {
    const failed = await store.failStaleReceipts({ tenantId, now, limit:limitPerTenant });
    results.push(...failed);
  }
  return {
    status:"ok",
    tenant_count:tenants.length,
    failed_receipts:results.length,
    receipts:results
  };
}

export function conversationRecoveryReadiness(databaseHealth, metrics, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maximumSuccessAgeMs = positiveInteger(options.maximumSuccessAgeMs, 30_000, 1_000, 15 * 60_000);
  const postgresReady = databaseHealth?.ok === true;
  const lastSuccessMs = Date.parse(String(metrics?.lastSuccessAt || ""));
  const successFresh = Number.isFinite(lastSuccessMs) && nowMs >= lastSuccessMs && nowMs - lastSuccessMs <= maximumSuccessAgeMs;
  const terminalErrorCode = metrics?.terminalErrorCode || null;
  const workerReady = metrics?.running === true
    && metrics?.stopping !== true
    && Number(metrics?.consecutiveFailures || 0) === 0
    && !terminalErrorCode
    && successFresh;
  const status = terminalErrorCode
    ? "failed"
    : metrics?.stopping
      ? "stopping"
      : Number(metrics?.consecutiveFailures || 0) > 0
        ? "degraded"
        : metrics?.running && successFresh
          ? "running"
          : metrics?.running
            ? "awaiting_success"
            : "not_running";
  return {
    ok:postgresReady && workerReady,
    checks:{
      postgres:{ ok:postgresReady, status:databaseHealth?.status || (postgresReady ? "ok" : "error") },
      conversation_recovery:{ ok:workerReady, status }
    }
  };
}

export function createConversationReceiptRecoveryWorker(options = {}) {
  const intervalMs = positiveInteger(options.intervalMs, 5_000, 10, 60_000);
  const maximumConsecutiveFailures = positiveInteger(options.maximumConsecutiveFailures, 3, 1, 20);
  const runPass = options.runPass || (() => runConversationReceiptRecoveryPass(options));
  if (typeof runPass !== "function") throw new TypeError("Conversation recovery runPass function is required");
  const observability = options.observability || getObservability({
    service:options.service || "huamei-conversation-recovery",
    environment:options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development"
  });
  const logger = options.logger || observability.logger;
  const loopAbort = new AbortController();
  let running = false;
  let stopping = false;
  let loopPromise = null;
  let terminalError = null;
  let consecutiveFailures = 0;
  let passCount = 0;
  let failedPassCount = 0;
  let recoveredReceiptCount = 0;
  let lastSuccessAt = null;

  const loop = async () => {
    while (!stopping) {
      try {
        const result = await runPass();
        passCount += 1;
        consecutiveFailures = 0;
        recoveredReceiptCount += Number(result?.failed_receipts || 0);
        lastSuccessAt = new Date().toISOString();
        if (result?.failed_receipts) {
          logger.info?.("conversation_receipt_recovery.completed", {
            failed_receipts:Number(result.failed_receipts),
            tenant_count:Number(result.tenant_count || 0)
          });
        }
      } catch (error) {
        failedPassCount += 1;
        consecutiveFailures += 1;
        const errorCode = safeRecoveryErrorCode(error);
        logger.error?.("conversation_receipt_recovery.failed", {
          error_code:errorCode,
          consecutive_failures:consecutiveFailures
        });
        if (error?.fatal === true || consecutiveFailures >= maximumConsecutiveFailures) {
          terminalError = error;
          throw error;
        }
      }
      if (!stopping) await sleep(intervalMs, loopAbort.signal);
    }
  };

  const start = () => {
    if (running) return;
    if (stopping || terminalError) {
      const error = new Error("Conversation recovery worker cannot restart after stop or terminal failure");
      error.code = "CONVERSATION_RECOVERY_RESTART_FORBIDDEN";
      throw error;
    }
    running = true;
    loopPromise = loop()
      .catch((error) => {
        terminalError ||= error;
        try {
          logger.fatal?.("conversation_receipt_recovery.terminal", {
            error_code:safeRecoveryErrorCode(error)
          });
        } catch {}
        throw error;
      })
      .finally(() => { running = false; });
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    loopAbort.abort();
    try { await loopPromise; }
    catch (error) { if (!terminalError) throw error; }
  };

  const metrics = () => ({
    running,
    stopping,
    terminalErrorCode:terminalError ? safeRecoveryErrorCode(terminalError) : null,
    consecutiveFailures,
    passCount,
    failedPassCount,
    recoveredReceiptCount,
    lastSuccessAt
  });

  return {
    start,
    stop,
    wait:() => loopPromise,
    metrics,
    get running() { return running; },
    get stopping() { return stopping; }
  };
}

export async function superviseConversationRecoveryRuntime(options = {}) {
  const worker = options.worker;
  const shutdown = options.shutdown;
  const signalPromise = options.signalPromise;
  if (!worker || typeof worker.wait !== "function") throw new TypeError("Conversation recovery worker wait() is required");
  if (typeof shutdown !== "function") throw new TypeError("Conversation recovery shutdown() is required");
  if (!signalPromise || typeof signalPromise.then !== "function") throw new TypeError("Conversation recovery signal promise is required");
  const outcome = await Promise.race([
    signalPromise.then((signal) => ({ kind:"signal", signal:String(signal || "SIGNAL") })),
    worker.wait().then(
      () => ({ kind:"worker_exit", error:null }),
      (error) => ({ kind:"worker_exit", error })
    )
  ]);
  if (outcome.kind === "signal") {
    await shutdown(outcome.signal);
    return { reason:"signal", signal:outcome.signal };
  }
  await shutdown("CONVERSATION_RECOVERY_TERMINAL");
  if (outcome.error) throw outcome.error;
  const error = new Error("Conversation recovery loop exited without an operator shutdown signal");
  error.code = "CONVERSATION_RECOVERY_LOOP_EXITED";
  throw error;
}

export async function runConversationRecoveryFromEnvironment() {
  const env = process.env;
  const once = process.argv.includes("--once");
  const environment = env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development";
  const observability = getObservability({ service:"huamei-conversation-recovery", environment, version:"1.0.0" });
  if (once) {
    try {
      const result = await runConversationReceiptRecoveryPass({ env });
      observability.logger.info("conversation_receipt_recovery.once_completed", {
        failed_receipts:Number(result.failed_receipts || 0),
        tenant_count:Number(result.tenant_count || 0)
      });
      return result;
    } finally {
      await closePostgresClient();
    }
  }

  const database = getPostgresClient();
  const intervalMs = positiveInteger(env.HUAMEI_CONVERSATION_RECOVERY_INTERVAL_MS, 5_000, 500, 60_000);
  const maximumSuccessAgeMs = positiveInteger(
    env.HUAMEI_CONVERSATION_RECOVERY_MAX_SUCCESS_AGE_MS,
    Math.max(15_000, intervalMs * 3),
    1_000,
    15 * 60_000
  );
  const worker = createConversationReceiptRecoveryWorker({
    env,
    tenantIds:configuredRecoveryTenants(env),
    intervalMs,
    maximumConsecutiveFailures:env.HUAMEI_CONVERSATION_RECOVERY_MAX_CONSECUTIVE_FAILURES,
    observability,
    environment
  });
  let observabilityRuntime;
  try {
    observabilityRuntime = await startObservabilityServer({
      observability,
      environment,
      token:String(env.HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN || ""),
      host:"127.0.0.1",
      port:positiveInteger(env.HUAMEI_CONVERSATION_RECOVERY_OBSERVABILITY_PORT, 9191, 1024, 65_535),
      readiness:async () => conversationRecoveryReadiness(
        await database.health(),
        worker.metrics(),
        { maximumSuccessAgeMs }
      )
    });
  } catch (error) {
    await closePostgresClient();
    throw error;
  }
  worker.start();
  observability.logger.info("conversation_receipt_recovery.worker_started", {
    tenant_count:configuredRecoveryTenants(env).length
  });

  let shutdownPromise;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await worker.stop();
      await new Promise((resolveClose) => observabilityRuntime.server.close(resolveClose));
      await closePostgresClient();
      observability.logger.info("conversation_receipt_recovery.worker_stopped", { signal });
    })();
    return shutdownPromise;
  };
  let resolveSignal;
  const signalPromise = new Promise((resolveSignalPromise) => { resolveSignal = resolveSignalPromise; });
  const onSigterm = () => resolveSignal("SIGTERM");
  const onSigint = () => resolveSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  try {
    await superviseConversationRecoveryRuntime({ worker, shutdown, signalPromise });
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await runConversationRecoveryFromEnvironment();
  } catch (error) {
    const logger = getObservability({ service:"huamei-conversation-recovery" }).logger;
    logger.fatal("conversation_receipt_recovery.process_exit", {
      error_code:safeRecoveryErrorCode(error)
    });
    process.exitCode = 1;
  }
}
