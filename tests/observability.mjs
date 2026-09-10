import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  createObservability,
  createObservabilityHttpHandler,
  createObservedHttpHandler,
  createRequestContext,
  createStructuredLogger,
  getRequestContext,
  outboundTraceHeaders,
  parseTraceparent,
  redactForLog,
  registerOutboxWorkerCollector,
  runWithRequestContext,
  safeRouteLabel
} from "../server/observability/index.mjs";

const rawSecret = "sk-production-secret-value-1234567890";
const rawPhone = "13800138000";
const rawEmail = "patient@example.com";
const rawIdentity = "110101199001011234";
const circular = { authorization:`Bearer ${rawSecret}` };
circular.self = circular;
const redacted = redactForLog({
  authorization:`Bearer ${rawSecret}`,
  nested:{ phone:rawPhone, email:rawEmail, id_card:rawIdentity, prompt:"我想做项目" },
  safe_error:new Error(`provider failed for ${rawPhone} using Bearer ${rawSecret}`),
  circular
});
const redactedJson = JSON.stringify(redacted);
for (const forbidden of [rawSecret, rawPhone, rawEmail, rawIdentity, "我想做项目"]) {
  assert.equal(redactedJson.includes(forbidden), false, `日志脱敏遗漏: ${forbidden}`);
}
assert.match(redactedJson, /REDACTED/);
assert.match(redactedJson, /CIRCULAR/);

const inboundTrace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const context = createRequestContext({
  service:"test-service",
  headers:{ "x-request-id":"req-safe-123", traceparent:inboundTrace }
});
assert.equal(context.requestId, "req-safe-123");
assert.equal(context.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
assert.equal(context.parentSpanId, "00f067aa0ba902b7");
assert.equal(parseTraceparent(context.traceparent).traceId, context.traceId);
assert.equal(parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01"), null);
const rejectedRequestId = createRequestContext({ headers:{ "x-request-id":rawPhone } });
assert.match(rejectedRequestId.requestId, /^req_[0-9a-f-]+$/);

const logLines = [];
const logger = createStructuredLogger({
  service:"test-service",
  environment:"production",
  secrets:[rawSecret],
  write:(line) => logLines.push(line)
});
await runWithRequestContext(context, async () => {
  await Promise.resolve();
  assert.equal(getRequestContext().traceId, context.traceId);
  const headers = outboundTraceHeaders({ Accept:"application/json" });
  assert.equal(headers["X-Request-Id"], context.requestId);
  assert.equal(headers.traceparent, context.traceparent);
  logger.info("model.call.completed", {
    request_id:"attacker-override",
    phone:rawPhone,
    authorization:`Bearer ${rawSecret}`,
    error:new Error(`network failed ${rawEmail}`)
  });
});
assert.equal(logLines.length, 1);
const structuredLog = JSON.parse(logLines[0]);
assert.equal(structuredLog.request_id, context.requestId);
assert.equal(structuredLog.trace_id, context.traceId);
assert.equal(structuredLog.phone, "[REDACTED]");
assert.equal(JSON.stringify(structuredLog).includes(rawSecret), false);
assert.equal(JSON.stringify(structuredLog).includes(rawEmail), false);
assert.equal("stack" in structuredLog.error, false, "生产日志不得输出堆栈和本机路径");

const observabilityLogs = [];
const observability = createObservability({
  service:"huamei-acquisition",
  version:"2.1.0",
  environment:"production",
  write:(line) => observabilityLogs.push(line)
});
const finishHttp = observability.startHttp({ method:"POST", route:`/customers/${rawPhone}/reply` });
finishHttp({ status:200 });
assert.equal(finishHttp({ status:500 }), false, "HTTP计时器必须幂等结束");
observability.observeModel({
  provider:"openai_compatible",
  model:"huamei-model-v1",
  outcome:"success",
  durationMs:125,
  promptTokens:120,
  completionTokens:32
});
observability.observeGraphRag({ mode:"local", outcome:"success", durationMs:42, cacheHit:true });
observability.recordHandover({ event:"requested", reason:`医疗异常 ${rawPhone}` });
observability.recordOutboxDelivery({ outcome:"published", count:2 });
observability.setOutboxSnapshot({ pending:3, retry:2, processing:1, ready:4, deadLetter:1, expiredLeases:0, backlog:6 });
observability.setDependencyReady("postgres", true);
const metricsText = await observability.render();
assert.match(metricsText, /# TYPE huamei_http_requests_total counter/);
assert.match(metricsText, /route="\/customers\/:id\/reply"/);
assert.match(metricsText, /huamei_model_tokens_total/);
assert.match(metricsText, /huamei_graphrag_queries_total/);
assert.match(metricsText, /huamei_handovers_total\{[^\n]*reason="medical_safety"/);
assert.match(metricsText, /huamei_outbox_events\{[^\n]*state="backlog"[^\n]*\} 6/);
assert.equal(metricsText.includes(rawPhone), false, "Prometheus label不得携带手机号");
assert.equal(safeRouteLabel(`/search/${rawEmail}`), "/search/:id");

let workerPublished = 3;
const collectorObservability = createObservability({ service:"huamei-outbox", write:() => {} });
const unregisterCollector = registerOutboxWorkerCollector(collectorObservability, {
  metrics:async () => ({
    total:{ pending:1, retry:0, processing:0, ready:1, deadLetter:0, expiredLeases:0, backlog:1 },
    counters:{ claimed:workerPublished, published:workerPublished, retried:0, deadLettered:0, leaseLost:0, failed:0 }
  })
});
let collectorText = await collectorObservability.render();
collectorText = await collectorObservability.render();
assert.match(collectorText, /huamei_outbox_deliveries_total\{[^\n]*outcome="published"[^\n]*\} 3/);
workerPublished = 5;
collectorText = await collectorObservability.render();
assert.match(collectorText, /huamei_outbox_deliveries_total\{[^\n]*outcome="published"[^\n]*\} 5/);
unregisterCollector();

assert.throws(
  () => createObservabilityHttpHandler({ observability, token:"weak", environment:"production" }),
  (error) => error.code === "OBSERVABILITY_METRICS_TOKEN_WEAK"
);

const metricsToken = "metrics-token-with-at-least-32-characters";
const protectedHandler = createObservabilityHttpHandler({
  observability,
  token:metricsToken,
  environment:"production",
  readiness:async () => ({
    ok:true,
    checks:{
      postgres:{ ok:true, status:"ready", latency_ms:4.12345, url:`postgresql://user:${rawSecret}@database/huamei` },
      redis:{ ok:true, status:"ready" }
    }
  })
});
const server = createServer(createObservedHttpHandler(protectedHandler, {
  observability,
  environment:"production",
  logger:observability.logger,
  routeResolver:(request) => new URL(request.url, "http://observability.invalid").pathname
}));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status:"ok", service:"huamei-acquisition" });

  const unauthorizedMetrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(unauthorizedMetrics.status, 401);
  assert.doesNotMatch(await unauthorizedMetrics.text(), /huamei_http_requests_total/);
  const wrongMetrics = await fetch(`${baseUrl}/metrics`, { headers:{ Authorization:"Bearer wrong-token" } });
  assert.equal(wrongMetrics.status, 401);

  const authorizedMetrics = await fetch(`${baseUrl}/metrics`, {
    headers:{ Authorization:`Bearer ${metricsToken}`, "X-Request-Id":"metrics-scrape-1", traceparent:inboundTrace }
  });
  assert.equal(authorizedMetrics.status, 200);
  assert.equal(authorizedMetrics.headers.get("x-request-id"), "metrics-scrape-1");
  assert.equal(parseTraceparent(authorizedMetrics.headers.get("traceparent")).traceId, context.traceId);
  const authorizedBody = await authorizedMetrics.text();
  assert.match(authorizedBody, /huamei_http_requests_total/);
  assert.equal(authorizedBody.includes(metricsToken), false);

  const unauthorizedReady = await fetch(`${baseUrl}/readyz`);
  assert.equal(unauthorizedReady.status, 401);
  const ready = await fetch(`${baseUrl}/readyz`, { headers:{ "X-Metrics-Token":metricsToken } });
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.status, "ready");
  assert.deepEqual(Object.keys(readyBody.checks).sort(), ["postgres", "redis"]);
  assert.equal(JSON.stringify(readyBody).includes(rawSecret), false, "readiness不得回显连接串或凭据");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

assert.ok(observabilityLogs.some((line) => {
  const record = JSON.parse(line);
  return record.event === "http.request.completed" && record.request_id;
}), "HTTP结构化日志必须带request_id");
for (const line of observabilityLogs) {
  assert.equal(line.includes(rawPhone), false);
  assert.equal(line.includes(rawSecret), false);
}

console.log("✓ 结构化日志深度脱敏、request/trace上下文与出站传递通过");
console.log("✓ HTTP/模型/GraphRAG/转人工/Outbox Prometheus指标与低基数标签通过");
console.log("✓ 公开liveness、受保护readiness/metrics与未授权拒绝通过");
