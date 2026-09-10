import { createHash, createHmac, randomBytes } from "node:crypto";
import { memberRepeatCheckSigner, memberRepeatCheckSigningConfigured } from "./member-repeatcheck-signing.mjs";

export const MEMBER_REPEATCHECK_METHOD = "meb.sync.client.repeatcheck";
const SCHEMA = "huamei.member-repeatcheck.v1";
const MAX_RESPONSE_BYTES = 16 * 1024;
const PROVIDED_HEADERS_ENDPOINT = "https://scrm.shhmwz.cn/api/thirdApi/checkPhoneExists";
const normalizeMobile = (value) => String(value || "").replace(/^\+?86/, "").replace(/[\s()-]/g, "");
const clean = (value, limit = 100) => String(value || "").trim().slice(0, limit);
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code) => Object.assign(new Error(code), { code });
const production = (env) => ["production", "prod"].includes(clean(env.HUAMEI_RUNTIME_ENV || env.NODE_ENV).toLowerCase());

export function memberRepeatCheckConfiguration(env = process.env, signer = memberRepeatCheckSigner) {
  const enabled = env.HUAMEI_MEMBER_CHECK_ENABLED === "true";
  const authMode = env.HUAMEI_MEMBER_CHECK_AUTH_MODE || "md5";
  let url;
  try { url = new URL(env.HUAMEI_MEMBER_CHECK_URL); } catch {}
  const endpointValid = Boolean(url && !url.username && !url.password && !url.hash && !url.search
    && (url.protocol === "https:" || (!production(env) && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))));
  const missing = [];
  if (!endpointValid) missing.push("endpoint");
  if (env.HUAMEI_MEMBER_CHECK_HTTP_METHOD !== "POST") missing.push("http_method");
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(clean(env.HUAMEI_MEMBER_CHECK_TENANT_ID))) missing.push("tenant_binding");
  if (!clean(env.HUAMEI_MEMBER_CHECK_AKEY) || /[\r\n]/.test(env.HUAMEI_MEMBER_CHECK_AKEY)) missing.push("akey");
  if (authMode === "provided_headers") {
    // Compatibility with the explicitly supplied and live-verified query headers.
    // Push-event documentation does not establish this endpoint's replay policy.
    if (env.HUAMEI_RUNTIME_ENV !== "development" || production(env) || env.NODE_ENV === "production") missing.push("provided_headers_development_only");
    if (env.HUAMEI_MEMBER_CHECK_URL !== PROVIDED_HEADERS_ENDPOINT) missing.push("provided_headers_endpoint");
    if (!/^\d{10}$/.test(env.HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP || "")) missing.push("provided_timestamp");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(env.HUAMEI_MEMBER_CHECK_PROVIDED_NONCE || "")) missing.push("provided_nonce");
    if (!/^[a-f0-9]{32}$/.test(env.HUAMEI_MEMBER_CHECK_PROVIDED_SIGN || "")) missing.push("provided_sign");
    if (env.HUAMEI_MEMBER_CHECK_TOKEN) missing.push("provided_headers_empty_token");
  } else if (authMode === "none") {
    // Hospital-confirmed read-only endpoint does not verify request signatures.
    if (env.HUAMEI_MEMBER_CHECK_URL !== PROVIDED_HEADERS_ENDPOINT) missing.push("unsigned_endpoint");
    if (env.HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS !== "duplicate_only") missing.push("unsigned_duplicate_only");
  } else if (authMode === "md5") {
    if (typeof signer !== "function") missing.push("signing_contract");
    else if (signer === memberRepeatCheckSigner && !memberRepeatCheckSigningConfigured(env)) missing.push("signing_secret");
  } else missing.push("auth_mode");
  if (env.HUAMEI_MEMBER_CHECK_OPERATION !== "read_only") missing.push("operation_contract");
  if (!["duplicate_only", "membership"].includes(env.HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS)) missing.push("result_semantics");
  return Object.freeze({
    enabled,
    ready:enabled && missing.length === 0,
    missing:Object.freeze(missing),
    method:MEMBER_REPEATCHECK_METHOD,
    auth_mode:authMode,
    result_semantics:env.HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS === "membership" ? "membership" : "duplicate_only"
  });
}

async function readBoundedJson(response, signal) {
  if (Number(response.headers?.get?.("content-length") || 0) > MAX_RESPONSE_BYTES) throw failure("INVALID_RESPONSE");
  const reader = response.body?.getReader?.();
  if (!reader) throw failure("INVALID_RESPONSE");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once:true });
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw failure("TIMEOUT");
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw failure("INVALID_RESPONSE");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    void reader.cancel().catch(() => {});
    throw failure("INVALID_RESPONSE");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

// Injectable signer and transport are server-only dependencies, never HTTP input.
export function createMemberRepeatCheckClient({
  env = process.env, signRequest = memberRepeatCheckSigner,
  fetchImpl = globalThis.fetch, now = () => Date.now()
} = {}) {
  const config = memberRepeatCheckConfiguration(env, signRequest);
  const timeoutMs = Math.min(5_000, Math.max(100, Number(env.HUAMEI_MEMBER_CHECK_TIMEOUT_MS) || 2_000));
  const configuredCacheMs = Number(env.HUAMEI_MEMBER_CHECK_CACHE_MS ?? 60_000);
  const cacheMs = Math.min(300_000, Math.max(0, Number.isFinite(configuredCacheMs) ? configuredCacheMs : 60_000));
  const tenantBinding = clean(env.HUAMEI_MEMBER_CHECK_TENANT_ID);
  const policyFingerprint = fingerprint([
    env.HUAMEI_MEMBER_CHECK_URL, tenantBinding, env.HUAMEI_MEMBER_CHECK_HOSPITAL_CODE,
    env.HUAMEI_MEMBER_CHECK_HOSPITAL, config.result_semantics, config.auth_mode,
    env.HUAMEI_MEMBER_CHECK_AKEY,
    ...(config.auth_mode === "provided_headers" ? [env.HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP,
      env.HUAMEI_MEMBER_CHECK_PROVIDED_NONCE, env.HUAMEI_MEMBER_CHECK_PROVIDED_SIGN] : [])
  ]);
  const inFlight = new Map();
  const record = (status, reason, at, extra = {}) => ({
    schema:SCHEMA, provider:"huamei_repeatcheck", auth_mode:config.auth_mode, status,
    is_repeat:null, member_status:"unknown", result_semantics:config.result_semantics,
    attempted_at:new Date(at).toISOString(), checked_at:null,
    reason_code:reason, policy_fingerprint:policyFingerprint, ...extra
  });

  async function check({ tenantId, sessionId, mobile, subjectReferenceHmac, verification, name, previous } = {}) {
    const at = now();
    const phone = normalizeMobile(mobile);
    try {
      const identity = createHmac("sha256", String(env.HUAMEI_IDENTITY_PEPPER || "times-beauty-local-mvp-v1"))
        .update(`${tenantId}:${phone}`).digest("hex");
      if (identity !== subjectReferenceHmac
          || verification?.method !== "format_validation"
          || verification?.status !== "pending_manual"
          || verification?.tenant_id !== tenantId
          || verification?.subject_reference_hmac !== identity
          || verification?.session_id !== sessionId) throw failure("CAPTURE_REQUIRED");
    } catch { return record("capture_required", "CAPTURE_REQUIRED", at); }
    if (!/^1[3-9]\d{9}$/.test(phone)) return record("failed", "INVALID_MOBILE", at);
    if (!config.ready) return record("not_configured", "CONFIGURATION_REQUIRED", at);
    if (tenantId !== tenantBinding) return record("not_configured", "TENANT_NOT_CONFIGURED", at);

    const age = at - Date.parse(previous?.checked_at || "");
    if (previous?.schema === SCHEMA && previous.provider === "huamei_repeatcheck"
        && previous.status === "checked" && typeof previous.is_repeat === "boolean"
        && previous.policy_fingerprint === policyFingerprint && age >= 0 && age < cacheMs) {
      return record("checked", null, Date.parse(previous.attempted_at) || at, {
        is_repeat:previous.is_repeat,
        member_status:config.result_semantics === "membership" ? (previous.is_repeat ? "member" : "non_member") : "unknown",
        checked_at:previous.checked_at
      });
    }
    const key = `${tenantId}:${subjectReferenceHmac}`;
    if (inFlight.has(key)) return structuredClone(await inFlight.get(key));

    const controller = new AbortController();
    let timer;
    const perform = async () => {
      const suppliedHeaders = config.auth_mode === "provided_headers";
      const unsigned = config.auth_mode === "none";
      const timestamp = suppliedHeaders ? env.HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP : String(Math.floor(at / 1_000));
      const nonce = suppliedHeaders ? env.HUAMEI_MEMBER_CHECK_PROVIDED_NONCE : randomBytes(16).toString("hex");
      // Minimum known field mapping. Do not copy example people/WeChat/projects.
      const body = Object.freeze(unsigned ? {phone:Object.freeze([phone])} : suppliedHeaders ? { phone:Object.freeze([phone]), timestamp } : {
        ...(clean(name, 40) ? { name:clean(name, 40) } : {}),
        phone:Object.freeze([phone]),
        date_time:new Date(at + 8 * 60 * 60 * 1_000).toISOString().slice(0, 19).replace("T", " "),
        ...(clean(env.HUAMEI_MEMBER_CHECK_HOSPITAL) ? { hospital:clean(env.HUAMEI_MEMBER_CHECK_HOSPITAL) } : {}),
        ...(clean(env.HUAMEI_MEMBER_CHECK_HOSPITAL_CODE, 40) ? { hospitalcode:clean(env.HUAMEI_MEMBER_CHECK_HOSPITAL_CODE, 40) } : {}),
        timestamp
      });
      const bodyText = JSON.stringify(body);
      const akey = clean(env.HUAMEI_MEMBER_CHECK_AKEY, 1024);
      const token = clean(env.HUAMEI_MEMBER_CHECK_TOKEN, 4096);
      const sign = unsigned ? null : suppliedHeaders ? env.HUAMEI_MEMBER_CHECK_PROVIDED_SIGN : await signRequest(Object.freeze({
        method:MEMBER_REPEATCHECK_METHOD, akey, token, timestamp, nonce, body, bodyText,
        signal:controller.signal
      }), { env });
      if (controller.signal.aborted) throw failure("TIMEOUT");
      if (!unsigned && (typeof sign !== "string" || !sign || sign.length > 1024 || /[\r\n]/.test(sign))) throw failure("SIGNATURE_UNAVAILABLE");
      const response = await fetchImpl(env.HUAMEI_MEMBER_CHECK_URL, {
        method:"POST", redirect:"error", signal:controller.signal,
        headers:{
          "Content-Type":"application/json", Accept:"application/json",
          "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          akey, method:MEMBER_REPEATCHECK_METHOD, token, timestamp, nonce, sign:unsigned ? "" : sign
        },
        body:bodyText
      });
      if (!response.ok || response.redirected) throw failure("PROVIDER_UNAVAILABLE");
      const result = await readBoundedJson(response, controller.signal);
      if (result?.isSuccess !== true) throw failure(unsigned && /签名|signature/i.test(String(result?.message || "")) ? "PROVIDER_SIGNATURE_REQUIRED" : "PROVIDER_REJECTED");
      if (!Array.isArray(result.data) || result.data.length !== 1
          || result.data[0]?.phone !== phone || typeof result.data[0]?.isRepeat !== "boolean") throw failure("INVALID_RESPONSE");
      const matched = result.data[0].isRepeat;
      return record("checked", null, at, {
        is_repeat:matched,
        member_status:config.result_semantics === "membership" ? (matched ? "member" : "non_member") : "unknown",
        checked_at:new Date(now()).toISOString()
      });
    };
    const pending = Promise.race([
      Promise.resolve().then(perform),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("TIMEOUT")); }, timeoutMs); })
    ]).catch((error) => record("failed",
      ["TIMEOUT", "SIGNATURE_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "PROVIDER_REJECTED", "PROVIDER_SIGNATURE_REQUIRED", "INVALID_RESPONSE"].includes(error?.code) ? error.code : "PROVIDER_UNAVAILABLE", at
    )).finally(() => { clearTimeout(timer); controller.abort(); inFlight.delete(key); });
    inFlight.set(key, pending);
    return structuredClone(await pending);
  }
  return Object.freeze({ config, check });
}

let runtimeClient;
export function getMemberRepeatCheckClient() {
  return runtimeClient ||= createMemberRepeatCheckClient();
}
