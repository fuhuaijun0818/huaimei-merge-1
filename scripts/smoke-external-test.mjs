#!/usr/bin/env node
// Run inside the external-test web container. Credentials are read only from
// its existing environment. Requests stay on loopback; public origins are
// headers only. Default requests are read-only (normal access audit may occur).
// --chat explicitly adds one marked, persisted, synthetic three-turn session.
import { randomUUID } from "node:crypto";

const chat = process.argv.includes("--chat");
const edge = process.argv.includes("--edge");
const requireLlm = process.argv.includes("--require-llm");
const unknown = process.argv.slice(2).filter((arg) => !["--chat", "--edge", "--require-llm"].includes(arg));
const emit = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);
const port = Number(process.env.PORT || 4173);
const domain = process.env.HUAMEI_EXTERNAL_DOMAIN || "";
if (unknown.length || !Number.isInteger(port) || port < 1 || port > 65535
    || (requireLlm && !chat) || (edge && !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(domain))) {
  emit({ check:"configuration", ok:false, error_code:"INVALID_ARGUMENTS_OR_PORT" });
  process.exit(2);
}
const base = edge ? `https://${domain}` : `http://127.0.0.1:${port}`;
const credentials = {};
for (const [role, prefix] of [["admin", "HUAMEI_ADMIN"], ["preview", "HUAMEI_PREVIEW"]]) {
  const user = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!user || !password) {
    emit({ check:"configuration", ok:false, error_code:`MISSING_${role.toUpperCase()}_CREDENTIALS` });
    process.exit(2);
  }
  credentials[role] = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

let passed = 0;
let failed = 0;
const record = (result) => {
  if (result.ok) passed += 1;
  else failed += 1;
  emit(result);
};
const errorCode = (value) => /^[A-Z0-9_]{1,80}$/.test(String(value || "")) ? value : undefined;
const counts = (value) => {
  if (Array.isArray(value)) return { items:value.length };
  if (!value || typeof value !== "object") return {};
  // Explicit collection names prevent record identifiers or user field names
  // being disclosed, even if the underlying API changes shape.
  return Object.fromEntries([
    "customers", "conversations", "messages", "documents", "items", "units",
    "products", "physicians", "agents", "channels", "handovers", "appointments"
  ].filter((key) => Array.isArray(value[key])).map((key) => [key, value[key].length]));
};
async function check(name, path, options = {}) {
  const { role = "admin", status = [200], shape, origin, method = "GET", body, headers = {}, validate } = options;
  try {
    const response = await fetch(new URL(path, base), {
      method,
      redirect:"manual",
      signal:AbortSignal.timeout(method === "POST" ? 90_000 : 30_000),
      headers:{
        ...(role ? { Authorization:credentials[role] } : {}),
        ...(origin ? { Origin:origin, "Sec-Fetch-Site":"same-origin" } : {}),
        ...(body ? { "Content-Type":"application/json" } : {}),
        ...headers
      },
      ...(body ? { body:JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    let json;
    try { json = JSON.parse(raw); } catch {}
    const data = json?.data;
    const shapeOk = !shape || (shape === "array" ? Array.isArray(data)
      : shape === "object" ? data !== null && typeof data === "object" && !Array.isArray(data)
        : shape === "html" ? /text\/html/i.test(response.headers.get("content-type") || "") && /<!doctype html|<html/i.test(raw)
          : false);
    const detail = validate ? validate({ response, json, raw }) : {};
    const ok = status.includes(response.status) && shapeOk && detail.ok !== false;
    record({
      check:name, http_status:response.status,
      ...(shape ? { data_shape_valid:shapeOk } : {}),
      ...(data ? { counts:counts(data) } : {}),
      ...(errorCode(json?.error?.code) ? { error_code:errorCode(json.error.code) } : {}),
      ...detail, ok
    });
    return { response, json, raw, ok };
  } catch (error) {
    record({ check:name, ok:false, http_status:0, error_code:error.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "REQUEST_FAILED" });
    return { ok:false };
  }
}

await check("management_home", "/", { shape:"html" });
const advisor = await check("advisor_home", "/advisor/", { role:"preview", shape:"html" });
if (advisor.ok) {
  const assets = [...advisor.raw.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
    .map((match) => new URL(match[1], `${base}/advisor/`))
    .filter((url) => url.origin === base && url.pathname.startsWith("/advisor/"));
  record({ check:"advisor_asset_references", ok:assets.length > 0, count:assets.length });
  for (let i = 0; i < assets.length; i += 1) {
    await check(`advisor_asset_${i + 1}`, `${assets[i].pathname}${assets[i].search}`, {
      role:"preview",
      validate:({ response, raw }) => ({ asset_content_valid:raw.length > 0 && !/text\/html/i.test(response.headers.get("content-type") || ""), ok:raw.length > 0 && !/text\/html/i.test(response.headers.get("content-type") || "") })
    });
  }
}

const endpoints = [
  ["domain_overlay", "/api/admin/management/domain-overlay", "object"],
  ["identity", "/api/admin/identity", "object"],
  ["accounts", "/api/admin/accounts", "array"],
  ["member_check_configuration", "/api/admin/integrations/member-check", "object"],
  ["knowledge_overview", "/api/admin/knowledge/governance", null, 403],
  ["knowledge_intake", "/api/admin/knowledge/intake/documents?limit=5", null, 403],
  ["customer_collection", "/api/local/acquisition-customers", null, 403],
  ["channel_collection", "/api/local/acquisition-channels", "array"],
  ["handovers", "/api/admin/acquisition/handovers?limit=5", null, 403],
  ["bad_cases", "/api/admin/acquisition/bad-cases?limit=5", null, 403],
  ["appointments", "/api/admin/appointment-intakes?limit=5", null, 403],
  ["schedule_slots", "/api/admin/schedule-slots", null, 403]
];
for (const [name, path, shape, expectedStatus = 200] of endpoints) {
  await check(name, path, { shape, status:[expectedStatus] });
  await check(`preview_denied_${name}`, path, { role:"preview", status:[401, 403] });
  await check(`anonymous_denied_${name}`, path, { role:null, status:[401, 403] });
}
await check("anonymous_advisor_denied", "/advisor/", { role:null, status:[401] });
await check("preview_management_home_denied", "/", { role:"preview", status:[401, 403] });
const origins = [...new Set(String(process.env.HUAMEI_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean))]
  .map((value, index) => [`configured_${index + 1}`, value]);
record({ check:"configured_origins", ok:origins.length > 0 && origins.every(([, value]) => {
  try { return new URL(value).origin === value && /^https?:/.test(value); } catch { return false; }
}) });
for (const [name, origin] of origins) {
  await check(`origin_${name}_management`, "/api/admin/management/domain-overlay", { origin, shape:"object" });
  await check(`origin_${name}_advisor_preflight`, "/api/public/acquisition-chat", {
    role:"preview", origin, method:"OPTIONS", status:[204],
    headers:{ "Access-Control-Request-Method":"POST", "Access-Control-Request-Headers":"content-type" },
    validate:({ response }) => ({ cors_origin_valid:response.headers.get("access-control-allow-origin") === origin, ok:response.headers.get("access-control-allow-origin") === origin })
  });
}

if (chat) {
  const marker = `DEPLOY_SMOKE_${randomUUID()}`;
  let sessionId;
  let sessionToken;
  let cookie;
  let llmTurns = 0;
  const messages = [`【${marker} 合成测试】我想咨询丰胸项目`, "第二种", "这是什么原理？"];
  for (let i = 0; i < messages.length; i += 1) {
    const result = await check(`synthetic_chat_turn_${i + 1}`, "/api/public/acquisition-chat", {
      role:"preview", origin:origins[i % origins.length][1], method:"POST",
      headers:{ "Idempotency-Key":`${marker}-${i + 1}`, ...(cookie ? { Cookie:cookie } : {}) },
      body:{ message:messages[i], ...(sessionId ? { session_id:sessionId, session_token:sessionToken } : {}) },
      validate:({ json }) => {
        const reply = typeof json?.reply === "string" ? json.reply : "";
        const stateOk = !!json?.session_id && !!json?.session_token && (!sessionId || json.session_id === sessionId);
        const contextOk = i === 0 ? /丰胸|隆胸|胸部/.test(reply) : /脂肪/.test(reply) && /丰胸|隆胸|胸部/.test(reply) && !/热玛吉/.test(reply);
        // The public channel deliberately omits provider usage. This flag is
        // set by the server only after a successful model completion; detailed
        // token counts must be inspected on the private service, not exposed
        // to the customer just to satisfy a deployment check.
        const llmUsed = json?.guardrails?.llm_used === true;
        if (llmUsed) llmTurns += 1;
        return { ok:stateOk && contextOk && reply.length > 0, session_continuity_valid:stateOk, context_valid:contextOk, llm_used:llmUsed, reply_characters:reply.length, citation_count:Array.isArray(json?.citations) ? json.citations.length : 0 };
      }
    });
    if (!result.ok) break;
    sessionId = result.json.session_id;
    sessionToken = result.json.session_token;
    const setCookie = result.response.headers.getSetCookie?.() || [];
    if (setCookie.length) cookie = setCookie.map((item) => item.split(";")[0]).join("; ");
    if (edge) record({ check:`secure_session_cookie_${i + 1}`, ok:setCookie.some((item) => /;\s*Secure(?:;|$)/i.test(item) && /;\s*HttpOnly(?:;|$)/i.test(item)) });
  }
  if (requireLlm) record({ check:"real_model_used", ok:llmTurns > 0, turns:llmTurns });
}
emit({ check:"summary", ok:failed === 0, passed, failed, synthetic_chat_enabled:chat, https_edge:edge });
process.exitCode = failed ? 1 : 0;
