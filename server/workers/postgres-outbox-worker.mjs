import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createPostgresClient } from "../platform/postgres.mjs";
import { createPostgresOutboxStore } from "../persistence/postgres-outbox-store.mjs";
import {
  createRequestContext,
  getObservability,
  outboundTraceHeaders,
  runWithRequestContext
} from "../observability/index.mjs";
import { startObservabilityServer } from "../observability-server.mjs";

const positiveInteger = (value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
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

const safeWorkerErrorCode = (error) => {
  const code = String(error?.code || "OUTBOX_WORKER_LOOP_EXITED").trim().toUpperCase();
  return /^[A-Z0-9_.:-]{2,96}$/.test(code) ? code : "OUTBOX_WORKER_LOOP_EXITED";
};

export function outboxWorkerReadiness(databaseHealth, metrics) {
  const postgresReady = databaseHealth?.ok === true;
  const running = metrics?.running === true;
  const stopping = metrics?.stopping === true;
  const terminalErrorCode = metrics?.terminalErrorCode || null;
  const workerReady = running && !stopping && !terminalErrorCode;
  const status = terminalErrorCode
    ? "failed"
    : stopping
      ? "stopping"
      : running
        ? "running"
        : "not_running";
  return {
    ok:postgresReady && workerReady,
    checks:{
      postgres:{ ok:postgresReady, status:databaseHealth?.status || (postgresReady ? "ok" : "error") },
      outbox_worker:{
        ok:workerReady,
        status,
        ...(terminalErrorCode ? { error_code:terminalErrorCode } : {})
      }
    }
  };
}

export function createHttpOutboxPublisher(options = {}) {
  const target = new URL(String(options.url || ""));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000, 250, 60_000);
  const serviceKey = String(options.serviceKey || "").trim();
  const production = ["prod", "production"].includes(String(options.environment || "development").trim().toLowerCase());
  if (production && target.protocol !== "https:") {
    const error = new Error("Production Outbox target must use HTTPS");
    error.code = "OUTBOX_HTTPS_TARGET_REQUIRED";
    throw error;
  }

  return async (event, context = {}) => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error("Outbox target timeout")), timeoutMs);
    timer.unref?.();
    const signals = [timeoutController.signal, context.signal].filter(Boolean);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const response = await fetchImpl(target, {
        method:"POST",
        headers:outboundTraceHeaders({
          "Content-Type":"application/json",
          "Idempotency-Key":event.eventId,
          "X-Huamei-Event-Id":event.eventId,
          "X-Huamei-Tenant-Id":event.tenantId,
          ...(serviceKey ? { "X-Service-Key":serviceKey } : {})
        }),
        body:JSON.stringify({
          event_id:event.eventId,
          tenant_id:event.tenantId,
          event_type:event.eventType,
          aggregate:{ type:event.aggregateType, id:event.aggregateId },
          occurred_at:event.createdAt,
          attempt:event.attempt,
          payload:event.payload,
          headers:event.headers
        }),
        signal
      });
      await response.body?.cancel?.().catch?.(() => {});
      if (!response.ok) {
        const error = new Error(`Outbox target returned HTTP ${response.status}`);
        error.code = `OUTBOX_TARGET_HTTP_${response.status}`;
        error.permanent = response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
        throw error;
      }
      return {
        transport:"http",
        status:Number(response.status),
        receiptId:String(response.headers.get("x-event-receipt-id") || response.headers.get("x-request-id") || "").slice(0, 256) || null
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createPostgresOutboxWorker(options = {}) {
  const store = options.store;
  if (!store || typeof store.claimBatch !== "function") throw new TypeError("Outbox store is required");
  if (typeof options.publish !== "function") throw new TypeError("Outbox publish function is required");
  const publish = options.publish;
  const tenantIds = [...new Set((options.tenantIds || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  if (!tenantIds.length) throw new TypeError("At least one Outbox tenant id is required");
  const workerId = String(options.workerId || `${hostname()}:${process.pid}:${randomUUID()}`).slice(0, 160);
  const batchSize = positiveInteger(options.batchSize, 25, 1, 500);
  const maxInFlight = positiveInteger(options.maxInFlight, 50, 1, 1000);
  const leaseMs = positiveInteger(options.leaseMs, 30_000, 1_000, 15 * 60_000);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, 500, 10, 60_000);
  const drainTimeoutMs = positiveInteger(options.drainTimeoutMs, 30_000, 100, 60_000);
  const baseRetryMs = positiveInteger(options.baseRetryMs, 1_000, 10, 60 * 60_000);
  const maxRetryMs = positiveInteger(options.maxRetryMs, 5 * 60_000, baseRetryMs, 24 * 60 * 60_000);
  const observability = options.observability || getObservability({
    service:options.service || process.env.HUAMEI_SERVICE_NAME || "huamei-outbox",
    environment:options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development"
  });
  const logger = options.logger || observability.logger;
  const loopAbort = new AbortController();
  const inFlight = new Map();
  let running = false;
  let stopping = false;
  let loopPromise = null;
  let terminalError = null;
  let tenantCursor = 0;
  const counters = {
    claimed:0,
    published:0,
    failed:0,
    retried:0,
    deadLettered:0,
    leaseLost:0,
    recoveredLeases:0,
    pollErrors:0
  };

  const processEventWithContext = async (event, entry) => {
    const heartbeatMs = Math.max(500, Math.floor(leaseMs / 3));
    entry.heartbeat = setInterval(() => {
      void store.renewLease({
        tenantId:event.tenantId,
        eventId:event.eventId,
        workerId,
        leaseToken:event.leaseToken,
        leaseMs
      }).catch((error) => {
        if (entry.settling) return;
        counters.leaseLost += Number(error?.code === "OUTBOX_LEASE_LOST");
        entry.controller.abort(error);
        clearInterval(entry.heartbeat);
        entry.heartbeat = null;
      });
    }, heartbeatMs);
    entry.heartbeat.unref?.();
    try {
      const receipt = await publish(event, {
        signal:entry.controller.signal,
        idempotencyKey:event.eventId,
        workerId
      });
      entry.settling = true;
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
      await store.markPublished({
        tenantId:event.tenantId,
        eventId:event.eventId,
        workerId,
        leaseToken:event.leaseToken,
        receipt
      });
      counters.published += 1;
      observability.recordOutboxDelivery({ outcome:"published" });
    } catch (error) {
      entry.settling = true;
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
      if (error?.code === "OUTBOX_LEASE_LOST") {
        counters.leaseLost += 1;
        observability.recordOutboxDelivery({ outcome:"lease_lost" });
        return;
      }
      counters.failed += 1;
      observability.recordOutboxDelivery({ outcome:"failed" });
      try {
        const disposition = await store.markFailed({
          tenantId:event.tenantId,
          eventId:event.eventId,
          workerId,
          leaseToken:event.leaseToken,
          error,
          permanent:Boolean(error?.permanent),
          baseRetryMs,
          maxRetryMs
        });
        if (disposition.status === "dead_letter") {
          counters.deadLettered += 1;
          observability.recordOutboxDelivery({ outcome:"dead_letter" });
        } else {
          counters.retried += 1;
          observability.recordOutboxDelivery({ outcome:"retry" });
        }
      } catch (markError) {
        counters.leaseLost += Number(markError?.code === "OUTBOX_LEASE_LOST");
        if (markError?.code === "OUTBOX_LEASE_LOST") observability.recordOutboxDelivery({ outcome:"lease_lost" });
        logger.error?.("outbox.mark_failed.error", { worker_id:workerId, event_id:event.eventId, error:markError });
      }
    } finally {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
    }
  };

  const processEvent = (event, entry) => runWithRequestContext(
    createRequestContext({
      service:observability.service,
      requestId:`outbox-${event.leaseToken}`
    }),
    () => processEventWithContext(event, entry)
  );

  const schedule = (event) => {
    const key = `${event.tenantId}:${event.eventId}`;
    if (inFlight.has(key)) return false;
    const entry = { event, controller:new AbortController(), heartbeat:null, promise:null, settling:false };
    entry.promise = processEvent(event, entry).finally(() => inFlight.delete(key));
    inFlight.set(key, entry);
    counters.claimed += 1;
    observability.recordOutboxDelivery({ outcome:"claimed" });
    counters.recoveredLeases += Number(event.recoveredLease);
    return true;
  };

  const runOnce = async () => {
    if (stopping) return 0;
    let capacity = maxInFlight - inFlight.size;
    if (capacity <= 0) return 0;
    let scheduled = 0;
    for (let offset = 0; offset < tenantIds.length && capacity > 0; offset += 1) {
      const index = (tenantCursor + offset) % tenantIds.length;
      const tenantId = tenantIds[index];
      const events = await store.claimBatch({
        tenantId,
        workerId,
        batchSize:Math.min(batchSize, capacity),
        leaseMs
      });
      for (const event of events) {
        if (schedule(event)) {
          scheduled += 1;
          capacity -= 1;
        }
      }
    }
    tenantCursor = (tenantCursor + 1) % tenantIds.length;
    return scheduled;
  };

  const loop = async () => {
    while (!stopping) {
      try {
        const scheduled = await runOnce();
        if (!scheduled) await sleep(pollIntervalMs, loopAbort.signal);
      } catch (error) {
        counters.pollErrors += 1;
        logger.error?.("outbox.poll.error", { worker_id:workerId, error });
        if (error?.fatal === true || error?.code === "OUTBOX_WORKER_FATAL") throw error;
        await sleep(pollIntervalMs, loopAbort.signal);
      }
    }
  };

  const start = () => {
    if (running) return;
    if (stopping || terminalError) {
      const error = new Error("Outbox worker cannot restart after stopping or a terminal loop failure");
      error.code = "OUTBOX_WORKER_RESTART_FORBIDDEN";
      throw error;
    }
    running = true;
    loopPromise = loop()
      .catch((error) => {
        terminalError = error;
        try {
          logger.fatal?.("outbox.worker.loop_exited", {
            worker_id:workerId,
            error_code:safeWorkerErrorCode(error)
          });
        } catch {}
        throw error;
      })
      .finally(() => { running = false; });
  };

  const stop = async () => {
    if (stopping) return { drained:inFlight.size === 0, inFlight:inFlight.size };
    stopping = true;
    loopAbort.abort();
    try {
      await loopPromise;
    } catch (error) {
      // A terminal loop failure is propagated by wait() to the runtime
      // supervisor. stop() still owns deterministic in-flight cleanup.
      if (!terminalError) throw error;
    }
    const drain = Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
    let drainTimer;
    const timedOut = new Promise((resolve) => {
      drainTimer = setTimeout(() => resolve("timeout"), drainTimeoutMs);
    });
    const outcome = await Promise.race([drain.then(() => "drained"), timedOut]);
    clearTimeout(drainTimer);
    if (outcome === "timeout") {
      for (const entry of inFlight.values()) {
        if (entry.heartbeat) clearInterval(entry.heartbeat);
        entry.heartbeat = null;
        entry.controller.abort(new Error("Outbox worker drain timeout"));
      }
    }
    return { drained:outcome === "drained", inFlight:inFlight.size };
  };

  const backlogMetrics = async () => {
    const tenants = await Promise.all(tenantIds.map((tenantId) => store.metrics(tenantId)));
    const total = tenants.reduce((summary, item) => ({
      pending:summary.pending + item.pending,
      retry:summary.retry + item.retry,
      processing:summary.processing + item.processing,
      published:summary.published + item.published,
      deadLetter:summary.deadLetter + item.deadLetter,
      ready:summary.ready + item.ready,
      expiredLeases:summary.expiredLeases + item.expiredLeases,
      backlog:summary.backlog + item.backlog,
      oldestBacklogSeconds:Math.max(summary.oldestBacklogSeconds, item.oldestBacklogSeconds)
    }), {
      pending:0, retry:0, processing:0, published:0, deadLetter:0,
      ready:0, expiredLeases:0, backlog:0, oldestBacklogSeconds:0
    });
    observability.setOutboxSnapshot(total);
    return {
      workerId,
      running,
      stopping,
      terminalErrorCode:terminalError ? safeWorkerErrorCode(terminalError) : null,
      inFlight:inFlight.size,
      counters:{ ...counters },
      total,
      tenants
    };
  };

  return {
    workerId,
    start,
    stop,
    runOnce,
    wait:() => loopPromise,
    metrics:backlogMetrics,
    get inFlight() { return inFlight.size; },
    get running() { return running; },
    get stopping() { return stopping; }
  };
}

export async function superviseOutboxRuntime(options = {}) {
  const worker = options.worker;
  const shutdown = options.shutdown;
  const signalPromise = options.signalPromise;
  if (!worker || typeof worker.wait !== "function") throw new TypeError("Outbox worker wait() is required");
  if (typeof shutdown !== "function") throw new TypeError("Outbox runtime shutdown() is required");
  if (!signalPromise || typeof signalPromise.then !== "function") throw new TypeError("Outbox signal promise is required");
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
  await shutdown("OUTBOX_WORKER_TERMINAL");
  if (outcome.error) throw outcome.error;
  const error = new Error("Outbox worker loop exited without an operator shutdown signal");
  error.code = "OUTBOX_WORKER_LOOP_EXITED";
  throw error;
}

export async function runOutboxFromEnvironment() {
  const env = process.env;
  const tenantIds = String(env.HUAMEI_OUTBOX_TENANTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!tenantIds.length) throw new Error("HUAMEI_OUTBOX_TENANTS is required");
  const targetUrl = String(env.HUAMEI_OUTBOX_TARGET_URL || "").trim();
  if (!targetUrl) throw new Error("HUAMEI_OUTBOX_TARGET_URL is required");
  const database = createPostgresClient({
    connectionString:String(env.HUAMEI_OUTBOX_DATABASE_URL || env.HUAMEI_DATABASE_URL || env.DATABASE_URL || ""),
    applicationName:`huamei-outbox-${hostname()}`
  });
  const health = await database.health();
  if (!health.ok) throw new Error(`Outbox PostgreSQL is not ready: ${health.error?.code || health.status}`);
  const store = createPostgresOutboxStore({ postgres:database });
  const environment = env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development";
  const observability = getObservability({
    service:env.HUAMEI_SERVICE_NAME || "huamei-outbox",
    environment,
    version:"1.0.0"
  });
  const worker = createPostgresOutboxWorker({
    store,
    tenantIds,
    observability,
    environment,
    publish:createHttpOutboxPublisher({
      url:targetUrl,
      serviceKey:env.HUAMEI_OUTBOX_TARGET_SERVICE_KEY,
      timeoutMs:env.HUAMEI_OUTBOX_TARGET_TIMEOUT_MS,
      environment
    }),
    workerId:env.HUAMEI_OUTBOX_WORKER_ID,
    batchSize:env.HUAMEI_OUTBOX_BATCH_SIZE,
    maxInFlight:env.HUAMEI_OUTBOX_MAX_IN_FLIGHT,
    leaseMs:env.HUAMEI_OUTBOX_LEASE_MS,
    pollIntervalMs:env.HUAMEI_OUTBOX_POLL_INTERVAL_MS,
    drainTimeoutMs:env.HUAMEI_OUTBOX_DRAIN_TIMEOUT_MS,
    baseRetryMs:env.HUAMEI_OUTBOX_BASE_RETRY_MS,
    maxRetryMs:env.HUAMEI_OUTBOX_MAX_RETRY_MS
  });
  const metricsToken = String(env.HUAMEI_METRICS_TOKEN || "").trim();
  const production = ["prod", "production"].includes(String(environment).trim().toLowerCase());
  const observabilityRuntime = production || metricsToken
    ? await startObservabilityServer({
        observability,
        environment,
        token:metricsToken,
        host:env.HUAMEI_OBSERVABILITY_HOST,
        port:env.HUAMEI_OBSERVABILITY_PORT,
        allowNonLoopback:env.HUAMEI_OBSERVABILITY_ALLOW_NON_LOOPBACK,
        readiness:async () => {
          const [databaseHealth, metrics] = await Promise.all([database.health(), worker.metrics()]);
          return outboxWorkerReadiness(databaseHealth, metrics);
        }
      })
    : null;
  const metricsIntervalMs = positiveInteger(env.HUAMEI_OUTBOX_METRICS_INTERVAL_MS, 60_000, 5_000, 15 * 60_000);
  const metricsTimer = setInterval(() => {
    void worker.metrics().then((metrics) => observability.logger.info("outbox.metrics", {
      in_flight:metrics.inFlight,
      count:metrics.total.backlog,
      state:metrics.stopping ? "stopping" : "running"
    })).catch((error) => observability.logger.error("outbox.metrics.error", { error }));
  }, metricsIntervalMs);
  metricsTimer.unref?.();
  worker.start();
  observability.logger.info("outbox.worker.started", { worker_id:worker.workerId, count:tenantIds.length });

  let shutdownPromise;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      clearInterval(metricsTimer);
      const result = await worker.stop();
      const metrics = await worker.metrics().catch(() => null);
      if (observabilityRuntime) await new Promise((resolveClose) => observabilityRuntime.server.close(resolveClose));
      await database.close();
      observability.logger.info("outbox.worker.stopped", {
        signal,
        drained:result.drained,
        in_flight:result.inFlight,
        count:metrics?.total?.backlog ?? 0
      });
      if (!result.drained) process.exitCode = 1;
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
    await superviseOutboxRuntime({ worker, shutdown, signalPromise });
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runOutboxFromEnvironment().catch((error) => {
    const logger = getObservability({ service:process.env.HUAMEI_SERVICE_NAME || "huamei-outbox" }).logger;
    logger.fatal("outbox.worker.fatal", { error });
    process.exitCode = 1;
  });
}
