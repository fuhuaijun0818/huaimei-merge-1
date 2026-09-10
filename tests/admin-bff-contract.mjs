import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const upstreamRequests = [];
const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  upstreamRequests.push({
    method:request.method,
    url:request.url,
    authorization:request.headers.authorization,
    callerId:request.headers["x-caller-id"],
    serviceKey:request.headers["x-service-key"],
    idempotencyKey:request.headers["idempotency-key"],
    body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null
  });
  response.writeHead(request.url.includes("human-work") ? 201 : 200, { "Content-Type":"application/json" });
  response.end(JSON.stringify({ data:{ accepted:true }, request_id:"upstream-request" }));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const { port } = upstream.address();
const serverSecret = "gateway-server-secret-only-9x7c5v3b1n8m6a4s";
process.env.HUAMEI_ACQUISITION_SERVICE_URL = `http://127.0.0.1:${port}`;
process.env.HUAMEI_ACQUISITION_CALLER_ID = "huamei_web_gateway";
process.env.HUAMEI_ACQUISITION_CALLER_SECRET = serverSecret;
process.env.HUAMEI_ACQUISITION_TENANT_ID = "tenant-a";
process.env.HUAMEI_PUBLIC_TENANT_ID = "tenant-a";
// This contract exercises the production BFF boundary. Local development has a
// separate loopback-only, gateway-signed compatibility test.
process.env.HUAMEI_RUNTIME_ENV = "production";

try {
  const { callAcquisitionAdminOperation } = await import(`../server/acquisition-service-client.mjs?admin-bff=${Date.now()}`);
  const bearer = "Bearer verified-human-token";
  await callAcquisitionAdminOperation({
    operation:"handovers.list",
    tenantId:"tenant-a",
    authorization:bearer,
    query:{ status:"pending", limit:20 },
    requestId:"bff-list"
  });
  await callAcquisitionAdminOperation({
    operation:"handovers.claim",
    handoverId:"ho_deadbeef",
    tenantId:"tenant-a",
    authorization:bearer,
    payload:{},
    requestId:"bff-claim",
    idempotencyKey:"claim-once"
  });
  await callAcquisitionAdminOperation({
    operation:"handovers.complete",
    handoverId:"ho_deadbeef",
    tenantId:"tenant-a",
    authorization:bearer,
    payload:{ resolution:"已完成实名跟进", minutes:5.5, notes:"电话回访" },
    requestId:"bff-complete",
    idempotencyKey:"complete-with-work-once"
  });
  await callAcquisitionAdminOperation({
    operation:"handovers.contact-reveal",
    handoverId:"ho_deadbeef",
    tenantId:"tenant-a",
    authorization:bearer,
    payload:{},
    requestId:"bff-contact-reveal",
    idempotencyKey:"contact-reveal-once"
  });
  assert.equal(upstreamRequests.length, 4);
  for (const request of upstreamRequests) {
    assert.equal(request.authorization, bearer, "BFF必须原样转发人员Bearer");
    assert.equal(request.callerId, "huamei_web_gateway");
    assert.equal(request.serviceKey, serverSecret, "服务密钥必须由网关服务端添加");
  }
  assert.match(upstreamRequests[0].url, /tenant_id=tenant-a/);
  assert.equal(upstreamRequests[1].body.tenant_id, "tenant-a");
  assert.equal(upstreamRequests[2].body.tenant_id, "tenant-a");
  assert.equal(upstreamRequests[2].body.minutes, 5.5, "BFF必须在同一完结请求中转发工时");
  assert.equal(upstreamRequests[2].body.notes, "电话回访");
  assert.equal(upstreamRequests[2].idempotencyKey, "complete-with-work-once");
  assert.equal(upstreamRequests[3].method, "POST");
  assert.match(upstreamRequests[3].url, /\/v1\/handovers\/ho_deadbeef\/contact-reveal\?tenant_id=tenant-a/);
  assert.deepEqual(upstreamRequests[3].body, { tenant_id:"tenant-a" });
  assert.equal(upstreamRequests[3].idempotencyKey, "contact-reveal-once");
  await assert.rejects(
    callAcquisitionAdminOperation({ operation:"handovers.list", tenantId:"tenant-b", authorization:bearer }),
    (error) => error.code === "TENANT_ACCESS_DENIED",
    "BFF不得把人员令牌导向网关未绑定的租户"
  );
  await assert.rejects(
    callAcquisitionAdminOperation({ operation:"handovers.list", tenantId:"tenant-a", authorization:"" }),
    (error) => error.code === "OIDC_TOKEN_MISSING"
  );

  const [routerSource, clientSource] = await Promise.all([
    readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/acquisition-service-client.mjs", import.meta.url), "utf8")
  ]);
  assert.match(routerSource, /\/api\/admin\/acquisition\/handovers/);
  assert.match(routerSource, /MANAGEMENT_ROLES\.operationsAgent/);
  assert.match(routerSource, /requiredAllRoles:\[MANAGEMENT_ROLES\.operationsAgent, MANAGEMENT_ROLES\.contactReveal\]/);
  assert.match(routerSource, /management\.contact\.reveal_authorized/,
    "BFF前置审计只能表示授权通过，不得误记为已披露联系方式");
  assert.match(routerSource, /outcome:contactRevealMatch\s*\?\s*["']authorized["']/,
    "联系方式披露成功与失败应由保险箱审计决定");
  assert.match(routerSource, /ADMIN_IDENTITY_OVERRIDE_FORBIDDEN/);
  assert.match(routerSource, /authorization:request\.headers\.authorization/);
  assert.doesNotMatch(routerSource, /request\.headers\[?["']x-service-key/i, "浏览器请求头不得作为服务密钥来源");
  assert.match(clientSource, /"X-Service-Key":SERVICE_CALLER_SECRET/);
  console.log("✓ 人工接管BFF的OIDC、租户、Bearer代转与服务密钥边界通过");
} finally {
  await new Promise((resolve) => upstream.close(resolve));
}
