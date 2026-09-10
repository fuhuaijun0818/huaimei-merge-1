import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage();
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

const headerValue = (headers, name) => {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "").trim();
  return String(headers[name] ?? headers[name.toLowerCase()] ?? "").trim();
};

const nonZeroHex = (value) => !/^0+$/.test(value);
const safeRequestId = (value) => requestIdPattern.test(value)
  && !/^1[3-9]\d{9}$/.test(value)
  && !/^\d{17}[0-9Xx]$/.test(value)
  && !/(?:secret|password|bearer|token|api[_-]?key)/i.test(value);

export function parseTraceparent(value) {
  const match = String(value || "").trim().toLowerCase().match(/^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/);
  if (!match || match[1] === "ff" || !nonZeroHex(match[2]) || !nonZeroHex(match[3])) return null;
  return { version:match[1], traceId:match[2], parentSpanId:match[3], flags:match[4] };
}

export function createRequestContext(options = {}) {
  const headers = options.headers || {};
  const suppliedRequestId = String(options.requestId || headerValue(headers, "x-request-id") || "").trim();
  const parent = parseTraceparent(options.traceparent || headerValue(headers, "traceparent"));
  const traceId = parent?.traceId || randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const requestId = safeRequestId(suppliedRequestId) ? suppliedRequestId : `req_${randomUUID()}`;
  const flags = parent?.flags || "01";
  return Object.freeze({
    requestId,
    traceId,
    spanId,
    parentSpanId:parent?.parentSpanId || null,
    traceparent:`00-${traceId}-${spanId}-${flags}`,
    service:String(options.service || "huamei-service").trim().slice(0, 80) || "huamei-service",
    startedAt:Number(options.startedAt || performance.now())
  });
}

export const runWithRequestContext = (context, operation) => {
  if (!context || typeof operation !== "function") throw new TypeError("context and operation are required");
  return storage.run(context, operation);
};

export const getRequestContext = () => storage.getStore() || null;

export function outboundTraceHeaders(headers = {}, context = getRequestContext()) {
  const result = { ...headers };
  if (!context) return result;
  result["X-Request-Id"] = context.requestId;
  result.traceparent = context.traceparent;
  return result;
}

export function isValidTraceContext(context) {
  return Boolean(
    context
    && safeRequestId(String(context.requestId || ""))
    && traceIdPattern.test(String(context.traceId || ""))
    && spanIdPattern.test(String(context.spanId || ""))
  );
}
