import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createObservability,
  createObservabilityHttpHandler,
  createObservedHttpHandler
} from "./observability/index.mjs";

const loopback = (value) => ["127.0.0.1", "localhost", "::1"].includes(String(value || "").toLowerCase());

export function createObservabilityServer(options = {}) {
  const environment = String(options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development").trim().toLowerCase();
  const service = String(options.service || "huamei-observability").trim().slice(0, 80);
  const observability = options.observability || createObservability({ service, environment, version:options.version || "1.0.0" });
  const handler = createObservabilityHttpHandler({
    observability,
    token:options.token,
    environment,
    service,
    readiness:options.readiness
  });
  const observed = createObservedHttpHandler(handler, {
    observability,
    environment,
    service,
    logger:observability.logger,
    routeResolver:(request) => new URL(request.url || "/", "http://observability.invalid").pathname
  });
  const server = createServer(observed);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 15_000;
  return { server, observability };
}

export async function startObservabilityServer(options = {}) {
  const environment = String(options.environment || process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development").trim().toLowerCase();
  const production = ["prod", "production"].includes(environment);
  const host = String(options.host || process.env.HUAMEI_OBSERVABILITY_HOST || "127.0.0.1").trim();
  const port = Number(options.port ?? process.env.HUAMEI_OBSERVABILITY_PORT ?? 9190);
  if (production && !loopback(host) && String(options.allowNonLoopback ?? process.env.HUAMEI_OBSERVABILITY_ALLOW_NON_LOOPBACK).toLowerCase() !== "true") {
    const error = new Error("Production observability endpoint defaults to loopback; explicitly opt in before binding externally");
    error.code = "OBSERVABILITY_EXTERNAL_BINDING_DENIED";
    throw error;
  }
  const runtime = createObservabilityServer({
    ...options,
    environment,
    token:options.token || process.env.HUAMEI_METRICS_TOKEN
  });
  await new Promise((resolveListen, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(port, host, resolveListen);
  });
  const address = runtime.server.address();
  runtime.observability.logger.info("observability.server.started", {
    bind_address:loopback(host) ? "loopback" : "external",
    port:typeof address === "object" ? address.port : port
  });
  return { ...runtime, host, port:typeof address === "object" ? address.port : port };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const runtime = await startObservabilityServer();
  let closing = false;
  const close = (signal) => {
    if (closing) return;
    closing = true;
    runtime.server.close(() => {
      runtime.observability.logger.info("observability.server.stopped", { signal });
    });
  };
  process.once("SIGINT", () => close("SIGINT"));
  process.once("SIGTERM", () => close("SIGTERM"));
}
