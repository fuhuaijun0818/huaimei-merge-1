// Offline regression must not inherit live member credentials from .env.local.
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { issueExternalTestManagementIdentity, verifyExternalTestManagementIdentity } from "../server/platform/local-management-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), "huamei-external-bridge-"));
const env = {
  ...process.env, NODE_ENV:"production", HUAMEI_RUNTIME_ENV:"staging",
  HUAMEI_EXTERNAL_TEST_MODE:"true",
  HUAMEI_EXTERNAL_TEST_ADMIN_BRIDGE_SECRET:"external-test-bridge-independent-secret-0123456789",
  HUAMEI_ACQUISITION_SERVICE_KEY:"external-test-service-independent-secret-0123456789",
  HUAMEI_ACQUISITION_CALLER_SECRET:"external-test-service-independent-secret-0123456789",
  HUAMEI_ACQUISITION_CLIENTS_JSON:"", HUAMEI_ACQUISITION_CALLER_ID:"huamei_web_gateway",
  HUAMEI_LOCAL_ADMIN_SUBJECT:"external-bridge-admin", HUAMEI_LOCAL_MANAGEMENT_ROLE:"presales",
  HUAMEI_PUBLIC_TENANT_ID:"huamei-shanghai", HUAMEI_DEFAULT_TENANT_ID:"huamei-shanghai",
  HUAMEI_ACQUISITION_TENANT_ID:"huamei-shanghai", HUAMEI_HOST:"0.0.0.0",
  HUAMEI_ACQUISITION_SERVICE_HOST:"0.0.0.0", HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"false",
  HUAMEI_ADMIN_USERNAME:"bridge-admin", HUAMEI_ADMIN_PASSWORD:"Admin-test-0123456789-strong",
  HUAMEI_PREVIEW_USERNAME:"bridge-preview", HUAMEI_PREVIEW_PASSWORD:"Preview-test-0123456789-strong",
  HUAMEI_API_KEY:"api-test-0123456789-independent-key",
  HUAMEI_ALLOWED_ORIGINS:"http://127.0.0.1", HUAMEI_LLM_ENABLED:"false", HUAMEI_GRAPHRAG_ENABLED:"false",
  HUAMEI_PERSISTENCE_BACKEND:"local_json", HUAMEI_CACHE_BACKEND:"memory", MINIMAX_REAL_CALL_ENABLED:"false",
  PHYSICIAN_AVATAR_RUNTIME_ROOT:runtime,
  ...Object.fromEntries([
    "HUAMEI_ACQUISITION_SESSION_STORE_FILE", "HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE",
    "HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE", "HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE",
    "HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE", "HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE",
    "HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE", "HUAMEI_LEAD_STORE_FILE", "HUAMEI_APPOINTMENT_REGISTRATION_FILE"
  ].map((name) => [name, ":memory:"]))
};
const proofOptions = { env, subject:"external-bridge-admin", callerId:"huamei_web_gateway", tenantId:"huamei-shanghai", method:"GET", pathname:"/v1/handovers", serviceUrl:new URL("http://acquisition:4180") };
const proof = issueExternalTestManagementIdentity(proofOptions);
const verifyOptions = { ...proofOptions, headers:proof.headers, remoteAddress:"172.20.0.3", authenticatedCaller:{ caller_id:"huamei_web_gateway", service_key_verified:true } };
assert.equal(verifyExternalTestManagementIdentity(verifyOptions).subject, "external-bridge-admin");
for (const override of [
  { env:{ ...env, HUAMEI_RUNTIME_ENV:"production" } },
  { env:{ ...env, HUAMEI_EXTERNAL_TEST_MODE:"false" } },
  { tenantId:"another-tenant" }, { remoteAddress:"139.196.232.219" },
  { authenticatedCaller:{ caller_id:"huamei_web_gateway", service_key_verified:false } },
  { authenticatedCaller:{ caller_id:"forged-gateway", service_key_verified:true } },
  { pathname:"/v1/handovers/forged/claim" }, { method:"POST" },
  { headers:{ ...proof.headers, "x-huamei-external-admin-subject":"forged-admin" } },
  { nowMs:Date.now() + 60_000 }
]) assert.throws(() => verifyExternalTestManagementIdentity({ ...verifyOptions, ...override }));
assert.throws(() => issueExternalTestManagementIdentity({ ...proofOptions, serviceUrl:new URL("https://example.com") }));
assert.throws(() => issueExternalTestManagementIdentity({ ...proofOptions, env:{ ...env, HUAMEI_EXTERNAL_TEST_ADMIN_BRIDGE_SECRET:"" } }));

const port = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const [servicePort, gatewayPort] = await Promise.all([port(), port()]);
const serviceUrl = `http://127.0.0.1:${servicePort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const processes = [];
const start = (file, extra) => {
  const child = spawn(process.execPath, [file], { cwd:root, env:{ ...env, ...extra }, stdio:["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  child.stderr.on("data", (data) => { output += data.toString(); });
  processes.push(child);
  return () => output;
};
const waitReady = async (url, output) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Service not ready: ${url}\n${output()}`);
};
try {
  const serviceOutput = start("server/acquisition-service-server.mjs", { HUAMEI_ACQUISITION_SERVICE_PORT:String(servicePort) });
  const gatewayOutput = start("server.mjs", { PORT:String(gatewayPort), HUAMEI_ACQUISITION_SERVICE_URL:serviceUrl });
  await Promise.all([waitReady(`${serviceUrl}/health`, serviceOutput), waitReady(`${gatewayUrl}/api/health`, gatewayOutput)]);
  const authorization = `Basic ${Buffer.from(`${env.HUAMEI_ADMIN_USERNAME}:${env.HUAMEI_ADMIN_PASSWORD}`).toString("base64")}`;
  for (const path of ["/api/admin/acquisition/handovers", "/api/admin/acquisition/bad-cases"]) {
    const response = await fetch(`${gatewayUrl}${path}`, { headers:{ Authorization:authorization } });
    assert.equal(response.status, path.endsWith("handovers") ? 200 : 403, `${path}: ${await response.text()}`);
    const anonymous = await fetch(`${gatewayUrl}${path}`);
    assert.ok([401, 403].includes(anonymous.status), "Browser access still requires administrator authentication");
    if (anonymous.status === 403) assert.equal((await anonymous.json()).error.code, "LOCAL_ONLY");
  }
  const directProof = issueExternalTestManagementIdentity(proofOptions);
  const headers = { ...directProof.headers, "X-Caller-Id":"huamei_web_gateway", "X-Tenant-Id":"huamei-shanghai" };
  assert.equal((await fetch(`${serviceUrl}/v1/handovers?tenant_id=huamei-shanghai`, { headers })).status, 401, "Valid signed human proof alone must not bypass service authentication");
  const handoverId = "ho_00000000-0000-4000-8000-000000000000";
  const claimPath = `/v1/handovers/${handoverId}/claim`;
  const writeProof = issueExternalTestManagementIdentity({ ...proofOptions, method:"POST", pathname:claimPath });
  const writeHeaders = { ...writeProof.headers, "X-Caller-Id":"huamei_web_gateway", "X-Tenant-Id":"huamei-shanghai", "X-Service-Key":env.HUAMEI_ACQUISITION_SERVICE_KEY, "Content-Type":"application/json" };
  const validClaim = await fetch(`${serviceUrl}${claimPath}`, {
    method:"POST", headers:writeHeaders, body:JSON.stringify({ tenant_id:"huamei-shanghai" })
  });
  assert.equal(validClaim.status, 404, "Valid identity must reach the business handler for a missing test handover");
  assert.equal((await validClaim.json()).error.code, "HANDOVER_NOT_FOUND");
  const gatewayClaim = await fetch(`${gatewayUrl}/api/admin/acquisition/handovers/${handoverId}/claim`, {
    method:"POST", headers:{ Authorization:authorization, "Content-Type":"application/json" }, body:"{}"
  });
  assert.equal(gatewayClaim.status, 404, "Authenticated gateway write must reach the acquisition business handler");
  assert.equal((await gatewayClaim.json()).error.code, "HANDOVER_NOT_FOUND");
  const invalid = await fetch(`${serviceUrl}${claimPath}`, {
    method:"POST", headers:{ ...writeHeaders, "x-huamei-external-admin-signature":"forged" },
    body:JSON.stringify({ tenant_id:"huamei-shanghai" })
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "EXTERNAL_TEST_MANAGEMENT_IDENTITY_INVALID");
  console.log("External-test management identity: staged BFF roundtrip and authorization rejection cases passed");
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(processes.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
  await rm(runtime, { recursive:true, force:true });
}
