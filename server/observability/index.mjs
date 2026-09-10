import { createStructuredLogger } from "./logger.mjs";
import { createHuameiMetrics } from "./metrics.mjs";

export { createRequestContext, getRequestContext, isValidTraceContext, outboundTraceHeaders, parseTraceparent, runWithRequestContext } from "./context.mjs";
export { createObservedHttpHandler, createObservabilityHttpHandler } from "./http.mjs";
export { createStructuredLogger } from "./logger.mjs";
export { Counter, Gauge, Histogram, PrometheusRegistry, createHuameiMetrics, safeRouteLabel } from "./metrics.mjs";
export { REDACTED_VALUE, redactForLog, redactString } from "./redaction.mjs";

const singletons = new Map();

export function createObservability(options = {}) {
  const metrics = createHuameiMetrics(options);
  const logger = options.logger || createStructuredLogger({
    service:metrics.service,
    environment:options.environment,
    level:options.logLevel,
    production:options.production,
    secrets:options.secrets,
    write:options.write
  });
  return Object.freeze({ ...metrics, logger });
}

export function getObservability(options = {}) {
  const service = String(options.service || process.env.HUAMEI_SERVICE_NAME || "huamei-service").trim().toLowerCase();
  if (!singletons.has(service)) singletons.set(service, createObservability({ ...options, service }));
  return singletons.get(service);
}

export function resetObservabilityForTest() {
  singletons.clear();
}

export function registerOutboxWorkerCollector(observability, worker) {
  if (!observability?.registry || typeof observability.setOutboxSnapshot !== "function") {
    throw new TypeError("observability with Outbox metrics is required");
  }
  if (!worker || typeof worker.metrics !== "function") throw new TypeError("Outbox worker metrics() is required");
  let previous = {};
  return observability.registry.addCollector(async () => {
    const snapshot = await worker.metrics();
    observability.setOutboxSnapshot(snapshot.total || {});
    const current = snapshot.counters || {};
    const mappings = {
      claimed:"claimed",
      published:"published",
      retried:"retry",
      deadLettered:"dead_letter",
      leaseLost:"lease_lost",
      failed:"failed"
    };
    for (const [field, outcome] of Object.entries(mappings)) {
      const next = Math.max(0, Number(current[field] || 0));
      const prior = Math.max(0, Number(previous[field] || 0));
      if (next > prior) observability.recordOutboxDelivery({ outcome, count:next - prior });
    }
    previous = { ...current };
  });
}
