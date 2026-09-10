import { createHash, timingSafeEqual } from "node:crypto";

import { createRequestContext, runWithRequestContext } from "./context.mjs";
import { createStructuredLogger } from "./logger.mjs";
import { safeRouteLabel } from "./metrics.mjs";

const header = (request, name) => {
  const value = request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
};

const digest = (value) => createHash("sha256").update(String(value || "")).digest();
const safeEqual = (left, right) => timingSafeEqual(digest(left), digest(right));
const productionEnvironment = (value) => ["prod", "production"].includes(String(value || "").trim().toLowerCase());

const send = (request, response, status, contentType, body, extraHeaders = {}) => {
  const payload = request.method === "HEAD" ? "" : String(body || "");
  response.writeHead(status, {
    "Content-Type":contentType,
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    ...extraHeaders
  });
  response.end(payload);
};

const sendJson = (request, response, status, body, extraHeaders = {}) => send(
  request,
  response,
  status,
  "application/json; charset=utf-8",
  JSON.stringify(body),
  extraHeaders
);

const readinessCheckName = (value) => /^[a-z][a-z0-9_.-]{0,47}$/.test(String(value || ""))
  ? String(value)
  : "dependency";

const readinessView = (report) => {
  const source = report && typeof report === "object" ? report : { ok:Boolean(report) };
  const checks = {};
  for (const [rawName, rawValue] of Object.entries(source.checks || {})) {
    const name = readinessCheckName(rawName);
    if (typeof rawValue === "boolean") checks[name] = { ok:rawValue };
    else if (rawValue && typeof rawValue === "object") checks[name] = {
      ok:rawValue.ok === true,
      status:/^[a-z][a-z0-9_.-]{0,31}$/i.test(String(rawValue.status || "")) ? String(rawValue.status).toLowerCase() : (rawValue.ok ? "ready" : "not_ready"),
      ...(Number.isFinite(Number(rawValue.latency_ms)) ? { latency_ms:Number(Number(rawValue.latency_ms).toFixed(3)) } : {})
    };
    else checks[name] = { ok:false };
  }
  return { ok:source.ok === true, status:source.ok === true ? "ready" : "not_ready", checks };
};

export function createObservedHttpHandler(handler, options = {}) {
  if (typeof handler !== "function") throw new TypeError("HTTP handler is required");
  const observability = options.observability;
  if (!observability || typeof observability.startHttp !== "function") throw new TypeError("observability metrics are required");
  const service = options.service || observability.service;
  const logger = options.logger || createStructuredLogger({ service, environment:options.environment });
  const routeResolver = options.routeResolver || ((request) => {
    try { return new URL(request.url || "/", "http://observability.invalid").pathname; }
    catch { return "__unmatched__"; }
  });

  return (request, response) => {
    const context = createRequestContext({ headers:request.headers, service });
    const route = safeRouteLabel(routeResolver(request));
    const endMetric = observability.startHttp({ method:request.method, route });
    let finished = false;
    const finish = (outcome = "") => {
      if (finished) return;
      finished = true;
      endMetric({ status:response.statusCode, outcome });
      runWithRequestContext(context, () => logger.info("http.request.completed", {
          method:String(request.method || "UNKNOWN").slice(0, 12),
          route,
          status_code:Number(response.statusCode || 0),
          outcome:outcome || undefined
        }));
    };
    response.setHeader("X-Request-Id", context.requestId);
    response.setHeader("traceparent", context.traceparent);
    response.once("finish", () => finish());
    response.once("close", () => { if (!response.writableEnded) finish("aborted"); });

    return runWithRequestContext(context, async () => {
      try {
        await handler(request, response);
      } catch (error) {
        logger.error("http.request.failed", { method:request.method, route, error });
        if (response.headersSent) response.destroy(error);
        else sendJson(request, response, 500, { error:{ code:"INTERNAL_ERROR" }, request_id:context.requestId });
      }
    });
  };
}

export function createObservabilityHttpHandler(options = {}) {
  const observability = options.observability;
  if (!observability || typeof observability.render !== "function") throw new TypeError("observability metrics are required");
  const environment = options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development";
  const token = String(options.token || "").trim();
  const minimumTokenLength = productionEnvironment(environment) ? 32 : 24;
  if (token.length < minimumTokenLength) {
    const error = new Error(`Metrics token must contain at least ${minimumTokenLength} characters`);
    error.code = "OBSERVABILITY_METRICS_TOKEN_WEAK";
    throw error;
  }
  const readiness = typeof options.readiness === "function"
    ? options.readiness
    : async () => ({ ok:true, checks:{ metrics_registry:{ ok:true, status:"ready" } } });
  const service = String(options.service || observability.service || "huamei-observability").slice(0, 80);

  const authorized = (request) => {
    const bearer = header(request, "authorization").match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
    const supplied = bearer || header(request, "x-metrics-token");
    return Boolean(supplied) && safeEqual(supplied, token);
  };

  const reject = (request, response) => sendJson(request, response, 401, {
    error:{ code:"METRICS_UNAUTHORIZED" }
  }, { "WWW-Authenticate":'Bearer realm="huamei-metrics"' });

  return async (request, response) => {
    let pathname;
    try { pathname = new URL(request.url || "/", "http://observability.invalid").pathname; }
    catch { pathname = "/invalid"; }
    if (!["GET", "HEAD"].includes(String(request.method || "").toUpperCase())) {
      sendJson(request, response, 405, { error:{ code:"METHOD_NOT_ALLOWED" } }, { Allow:"GET, HEAD" });
      return;
    }
    if (pathname === "/healthz") {
      sendJson(request, response, 200, { status:"ok", service });
      return;
    }
    if (pathname === "/metrics") {
      if (!authorized(request)) { reject(request, response); return; }
      const body = await observability.render();
      send(request, response, 200, "text/plain; version=0.0.4; charset=utf-8", body);
      return;
    }
    if (pathname === "/readyz") {
      if (!authorized(request)) { reject(request, response); return; }
      let view;
      try { view = readinessView(await readiness()); }
      catch { view = { ok:false, status:"not_ready", checks:{} }; }
      for (const [dependency, check] of Object.entries(view.checks)) observability.setDependencyReady?.(dependency, check.ok);
      sendJson(request, response, view.ok ? 200 : 503, { ...view, service });
      return;
    }
    sendJson(request, response, 404, { error:{ code:"NOT_FOUND" } });
  };
}
