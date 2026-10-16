import { getRequestContext } from "./context.mjs";
import { redactForLog } from "./redaction.mjs";

const ranks = { debug:10, info:20, warn:30, error:40, fatal:50 };
const environmentName = (value) => String(value || "development").trim().toLowerCase();
const productionEnvironment = (value) => ["prod", "production"].includes(environmentName(value));
const eventName = (value) => {
  const normalized = String(value || "application.event").trim().toLowerCase();
  return /^[a-z][a-z0-9_.:-]{0,95}$/.test(normalized) ? normalized : "application.event";
};
const allowedProductionField = /^(?:request_id|method|route|status_code|outcome|duration_ms|latency_ms|provider|model|mode|cache_hit|error|error_code|worker_id|event_id|attempt|max_attempts|bind_address|port|signal|dependency|state|count|version|index_version|release_id|tenant_hash|queue|retry_delay_ms|in_flight|drained|component|operation|driver)$/;

export function createStructuredLogger(options = {}) {
  const service = String(options.service || "huamei-service").trim().slice(0, 80) || "huamei-service";
  const environment = environmentName(options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV);
  const production = options.production ?? productionEnvironment(environment);
  const configuredLevel = String(options.level || process.env.HUAMEI_LOG_LEVEL || "info").trim().toLowerCase();
  const threshold = ranks[configuredLevel] || ranks.info;
  const configuredFields = options.fields || {};
  const write = options.write || ((line, level) => {
    const stream = ranks[level] >= ranks.error ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  });

  const safeFields = (fields) => {
    const redacted = redactForLog(fields, { production, secrets:options.secrets });
    if (!production || !redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
    const result = {};
    for (const [key, value] of Object.entries(redacted)) {
      if (value === "[REDACTED]") result[key] = value;
      else if (!allowedProductionField.test(key)) result[key] = "[OMITTED]";
      else if (key === "error" && value && typeof value === "object") {
        result.error = { name:value.name || "Error", code:value.code || "UNSPECIFIED" };
      } else result[key] = value;
    }
    return result;
  };
  const staticFields = safeFields(configuredFields);

  const emit = (level, event, fields = {}) => {
    if ((ranks[level] || ranks.info) < threshold) return null;
    const context = getRequestContext();
    const record = {
      ...staticFields,
      ...safeFields(fields),
      timestamp:new Date().toISOString(),
      level,
      service,
      environment,
      event:eventName(event),
      ...(context ? {
        request_id:context.requestId,
        trace_id:context.traceId,
        span_id:context.spanId
      } : {})
    };
    const line = JSON.stringify(record);
    write(line, level);
    return record;
  };

  const logger = {
    debug:(event, fields) => emit("debug", event, fields),
    info:(event, fields) => emit("info", event, fields),
    warn:(event, fields) => emit("warn", event, fields),
    error:(event, fields) => emit("error", event, fields),
    fatal:(event, fields) => emit("fatal", event, fields),
    child:(fields = {}) => createStructuredLogger({
      ...options,
      service,
      environment,
      production,
      level:configuredLevel,
      fields:{ ...staticFields, ...safeFields(fields) },
      write
    })
  };
  return Object.freeze(logger);
}
