import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getRedisClient } from "./redis.mjs";

const LOCAL_SESSION_SECRET = randomBytes(32).toString("base64url");
const SESSION_COOKIE = "hm_public_session";
const SESSION_TOKEN_PREFIX = "hms1";
const CANONICAL_PUBLIC_SESSION = /^ps_[A-Za-z0-9_-]{24,96}$/;

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const canonicalPayloadHash = (value) => createHash("sha256")
  .update(JSON.stringify(stableValue(value)))
  .digest("hex");

export const scopedKey = (...parts) => parts.map((part) => String(part || "-")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._:@/-]+/g, "_")
  .slice(0, 180)).join(":");

export function createMemoryFixedWindowStore({ maxKeys = 20_000 } = {}) {
  const buckets = new Map();
  return {
    driver:"memory_fixed_window",
    async consume(key, { limit, windowMs = 60_000, now = Date.now() }) {
      const windowStart = now - (now % windowMs);
      const current = buckets.get(key);
      const bucket = !current || current.windowStart !== windowStart
        ? { windowStart, count:0 }
        : current;
      bucket.count += 1;
      buckets.set(key, bucket);
      if (buckets.size > maxKeys) {
        const cutoff = now - windowMs * 2;
        for (const [candidate, value] of buckets) {
          if (value.windowStart < cutoff) buckets.delete(candidate);
          if (buckets.size <= maxKeys) break;
        }
        while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
      }
      return {
        allowed:bucket.count <= limit,
        remaining:Math.max(0, limit - bucket.count),
        resetAt:new Date(windowStart + windowMs).toISOString()
      };
    },
    async reset() { buckets.clear(); }
  };
}

const cloneValue = (value) => value === undefined ? undefined : structuredClone(value);
const claimToken = () => randomBytes(24).toString("base64url");

export function createMemoryIdempotencyStore({
  ttlMs = 10 * 60_000,
  lockTtlMs = 30_000,
  maxEntries = 5_000
} = {}) {
  const entries = new Map();
  const claims = new Map();
  const cleanup = (now = Date.now()) => {
    for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key);
    for (const [key, value] of claims) if (value.expiresAt <= now) claims.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    while (claims.size > maxEntries) claims.delete(claims.keys().next().value);
  };
  return {
    driver:"memory_ttl",
    async get(key) {
      cleanup();
      const value = entries.get(key);
      return value ? cloneValue(value.value) : null;
    },
    async put(key, value, options = {}) {
      cleanup();
      entries.set(key, {
        expiresAt:Date.now() + ttlMs,
        payloadHash:String(options.payloadHash || value?.payload_hash || ""),
        value:cloneValue(value)
      });
    },
    async claim(key, payloadHash) {
      cleanup();
      const hash = String(payloadHash || "");
      const completed = entries.get(key);
      if (completed) {
        if (completed.payloadHash && completed.payloadHash !== hash) {
          return { status:"conflict", payloadHash:completed.payloadHash };
        }
        return { status:"replay", value:cloneValue(completed.value) };
      }
      const active = claims.get(key);
      if (active) {
        return active.payloadHash !== hash
          ? { status:"conflict", payloadHash:active.payloadHash }
          : { status:"pending" };
      }
      const token = claimToken();
      claims.set(key, { token, payloadHash:hash, expiresAt:Date.now() + lockTtlMs });
      return { status:"claimed", token };
    },
    async complete(key, value, token) {
      cleanup();
      const active = claims.get(key);
      if (!active || !safeEqual(active.token, token)) return false;
      entries.set(key, {
        expiresAt:Date.now() + ttlMs,
        payloadHash:active.payloadHash,
        value:cloneValue(value)
      });
      claims.delete(key);
      return true;
    },
    async release(key, token) {
      cleanup();
      const active = claims.get(key);
      if (!active || !safeEqual(active.token, token)) return false;
      claims.delete(key);
      return true;
    },
    async reset() { entries.clear(); claims.clear(); }
  };
}

const redisNamespace = (value, fallback) => String(value || fallback)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9:_-]+/g, "_")
  .slice(0, 80) || fallback;
const redisDigest = (value) => createHash("sha256").update(String(value)).digest("hex");
const parseRedisJson = (raw, key) => {
  if (raw === null || raw === undefined || raw === "") return null;
  try { return JSON.parse(String(raw)); }
  catch (cause) {
    const error = new Error(`Redis idempotency value is invalid for ${redisDigest(key).slice(0, 12)}`, { cause });
    error.code = "IDEMPOTENCY_STORE_CORRUPT";
    throw error;
  }
};
const evalRedisAtomically = async (redis, script, keys, arguments_) => {
  if (typeof redis.getClient !== "function") return undefined;
  const client = await redis.getClient();
  if (!client || typeof client.sendCommand !== "function") return undefined;
  return client.sendCommand([
    "EVAL",
    script,
    String(keys.length),
    ...keys.map(String),
    ...arguments_.map(String)
  ]);
};

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const COMPLETE_IDEMPOTENCY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded_ok, claim = pcall(cjson.decode, current)
if not decoded_ok or claim.token ~= ARGV[1] then return 0 end
local stored = redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3])
if stored then
  redis.call('DEL', KEYS[1])
  return 1
end
local completed = redis.call('GET', KEYS[2])
if not completed then return 0 end
local result_ok, result = pcall(cjson.decode, completed)
if result_ok and result.payload_hash == claim.payload_hash then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

const RELEASE_IDEMPOTENCY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded_ok, claim = pcall(cjson.decode, current)
if not decoded_ok or claim.token ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export function createRedisFixedWindowStore({ redis, namespace = "huamei:rate" } = {}) {
  if (!redis || typeof redis.command !== "function") {
    throw new TypeError("Redis fixed-window store requires a Redis adapter with command()");
  }
  const prefix = redisNamespace(namespace, "huamei:rate");
  const windowKey = (key, windowStart) => `${prefix}:${redisDigest(key)}:${windowStart}`;
  const store = {
    driver:"redis_fixed_window",
    async consume(key, { limit, windowMs = 60_000, now = Date.now() }) {
      const normalizedLimit = Math.max(1, Number(limit) || 1);
      const normalizedWindow = Math.max(1_000, Number(windowMs) || 60_000);
      const windowStart = now - (now % normalizedWindow);
      const storageKey = windowKey(key, windowStart);
      const atomicCount = await evalRedisAtomically(
        redis,
        FIXED_WINDOW_SCRIPT,
        [storageKey],
        [normalizedWindow + 1_000]
      );
      const count = Number(atomicCount === undefined ? await redis.command("incr", storageKey) : atomicCount);
      if (!Number.isFinite(count) || count < 1) {
        const error = new Error("Redis returned an invalid fixed-window counter");
        error.code = "RATE_LIMIT_STORE_INVALID";
        throw error;
      }
      if (atomicCount === undefined && count === 1) {
        await redis.command("expire", storageKey, Math.max(2, Math.ceil(normalizedWindow / 1_000) + 1));
      }
      return {
        allowed:count <= normalizedLimit,
        remaining:Math.max(0, normalizedLimit - count),
        resetAt:new Date(windowStart + normalizedWindow).toISOString()
      };
    },
    async reset(key, { windowMs = 60_000, now = Date.now() } = {}) {
      if (!key) return false;
      const normalizedWindow = Math.max(1_000, Number(windowMs) || 60_000);
      const windowStart = now - (now % normalizedWindow);
      return Number(await redis.del(windowKey(key, windowStart))) > 0;
    }
  };
  return store;
}

export function createRedisIdempotencyStore({
  redis,
  ttlMs = 10 * 60_000,
  lockTtlMs = 30_000,
  namespace = "huamei:idempotency"
} = {}) {
  if (!redis || typeof redis.get !== "function" || typeof redis.set !== "function" || typeof redis.del !== "function") {
    throw new TypeError("Redis idempotency store requires get(), set() and del()");
  }
  const prefix = redisNamespace(namespace, "huamei:idempotency");
  const completedKey = (key) => `${prefix}:result:${redisDigest(key)}`;
  const lockKey = (key) => `${prefix}:lock:${redisDigest(key)}`;
  const completedTtl = Math.max(1_000, Number(ttlMs) || 10 * 60_000);
  const pendingTtl = Math.max(1_000, Math.min(Number(lockTtlMs) || 30_000, completedTtl));

  const completedValue = async (key) => parseRedisJson(await redis.get(completedKey(key)), key);
  const activeClaim = async (key) => parseRedisJson(await redis.get(lockKey(key)), key);

  return {
    driver:"redis_ttl",
    async get(key) {
      const completed = await completedValue(key);
      return completed?.state === "completed" ? cloneValue(completed.value) : null;
    },
    async put(key, value, options = {}) {
      const payloadHash = String(options.payloadHash || value?.payload_hash || "");
      await redis.set(completedKey(key), JSON.stringify({ state:"completed", payload_hash:payloadHash, value }), { PX:completedTtl });
    },
    async claim(key, payloadHash) {
      const hash = String(payloadHash || "");
      const completed = await completedValue(key);
      if (completed?.state === "completed") {
        return completed.payload_hash && completed.payload_hash !== hash
          ? { status:"conflict", payloadHash:completed.payload_hash }
          : { status:"replay", value:cloneValue(completed.value) };
      }
      const token = claimToken();
      const candidate = JSON.stringify({ state:"pending", payload_hash:hash, token });
      const result = await redis.set(lockKey(key), candidate, { NX:true, PX:pendingTtl });
      if (String(result || "").toUpperCase() === "OK") return { status:"claimed", token };

      // The owner may have completed between our first read and the failed
      // reservation. Re-read the result before reporting an in-flight request.
      const racedCompletion = await completedValue(key);
      if (racedCompletion?.state === "completed") {
        return racedCompletion.payload_hash && racedCompletion.payload_hash !== hash
          ? { status:"conflict", payloadHash:racedCompletion.payload_hash }
          : { status:"replay", value:cloneValue(racedCompletion.value) };
      }
      const active = await activeClaim(key);
      if (!active) {
        const retryToken = claimToken();
        const retryCandidate = JSON.stringify({ state:"pending", payload_hash:hash, token:retryToken });
        const retry = await redis.set(lockKey(key), retryCandidate, { NX:true, PX:pendingTtl });
        return String(retry || "").toUpperCase() === "OK"
          ? { status:"claimed", token:retryToken }
          : { status:"pending" };
      }
      return active.payload_hash !== hash
        ? { status:"conflict", payloadHash:active.payload_hash }
        : { status:"pending" };
    },
    async complete(key, value, token) {
      const active = await activeClaim(key);
      if (!active || !safeEqual(active.token, token)) return false;
      const encoded = JSON.stringify({ state:"completed", payload_hash:active.payload_hash, value });
      const atomicResult = await evalRedisAtomically(
        redis,
        COMPLETE_IDEMPOTENCY_SCRIPT,
        [lockKey(key), completedKey(key)],
        [token, encoded, completedTtl]
      );
      if (atomicResult !== undefined) return Number(atomicResult) === 1;
      const stored = await redis.set(completedKey(key), encoded, { NX:true, PX:completedTtl });
      if (String(stored || "").toUpperCase() !== "OK") {
        const winner = await completedValue(key);
        return Boolean(winner?.state === "completed" && winner.payload_hash === active.payload_hash);
      }
      const latest = await activeClaim(key);
      if (latest && safeEqual(latest.token, token)) await redis.del(lockKey(key));
      return true;
    },
    async release(key, token) {
      const active = await activeClaim(key);
      if (!active || !safeEqual(active.token, token)) return false;
      const atomicResult = await evalRedisAtomically(
        redis,
        RELEASE_IDEMPOTENCY_SCRIPT,
        [lockKey(key)],
        [token]
      );
      if (atomicResult !== undefined) return Number(atomicResult) === 1;
      return Number(await redis.del(lockKey(key))) > 0;
    },
    async reset(key) {
      if (!key) return false;
      return Number(await redis.del(completedKey(key), lockKey(key))) > 0;
    }
  };
}

const runtimeEnvironment = (env) => String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase();

export async function createRequestSecurityStores({ env = process.env, redis } = {}) {
  const production = ["prod", "production"].includes(runtimeEnvironment(env));
  const requestedBackend = String(env.HUAMEI_CACHE_BACKEND || env.HUAMEI_CACHE_DRIVER || "").trim().toLowerCase();
  const idempotencyTtlMs = Math.max(60_000, Number(env.HUAMEI_IDEMPOTENCY_TTL_MS) || 10 * 60_000);
  const idempotencyLockTtlMs = Math.max(30_000, Math.min(
    Number(env.HUAMEI_IDEMPOTENCY_LOCK_TTL_MS) || 2 * 60_000,
    idempotencyTtlMs
  ));
  if (production && requestedBackend !== "redis") {
    const error = new Error("Production request security requires HUAMEI_CACHE_BACKEND=redis");
    error.code = "PRODUCTION_REDIS_REQUIRED";
    throw error;
  }
  const backend = requestedBackend === "redis" ? "redis" : "memory";
  if (backend === "redis") {
    const adapter = redis || getRedisClient({ env });
    if (production) {
      const health = await adapter.health();
      if (!health?.ok) {
        const error = new Error(`Production Redis request-security dependency is not ready: ${health?.error?.code || health?.status || "unknown"}`);
        error.code = "PRODUCTION_REDIS_UNAVAILABLE";
        error.report = health;
        throw error;
      }
    }
    return {
      backend,
      redis:adapter,
      fixedWindowStore:createRedisFixedWindowStore({ redis:adapter }),
      idempotencyStore:createRedisIdempotencyStore({
        redis:adapter,
        ttlMs:idempotencyTtlMs,
        lockTtlMs:idempotencyLockTtlMs
      })
    };
  }
  return {
    backend,
    redis:null,
    fixedWindowStore:createMemoryFixedWindowStore({ maxKeys:20_000 }),
    idempotencyStore:createMemoryIdempotencyStore({
      ttlMs:idempotencyTtlMs,
      lockTtlMs:idempotencyLockTtlMs,
      maxEntries:5_000
    })
  };
}

const normalizeAddress = (value = "") => {
  let address = String(value || "").trim().replace(/^"|"$/g, "").toLowerCase();
  if (address.startsWith("[")) address = address.slice(1, address.indexOf("]") > 0 ? address.indexOf("]") : undefined);
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) address = address.replace(/:\d+$/, "");
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return address.slice(0, 128) || "unknown";
};

const trustedProxyAddresses = (env) => new Set(String(env.HUAMEI_TRUSTED_PROXY_ADDRESSES || "")
  .split(/[\s,]+/)
  .map(normalizeAddress)
  .filter((item) => item && item !== "unknown"));

export function resolvePublicClientAddress(request, env = process.env) {
  const remoteAddress = normalizeAddress(request.socket?.remoteAddress);
  const trusted = trustedProxyAddresses(env);
  const trustProxy = String(env.HUAMEI_TRUST_PROXY || "false").toLowerCase() === "true";
  if (!trustProxy || !trusted.has(remoteAddress)) {
    return { address:remoteAddress, source:"socket", trusted_proxy:false };
  }
  const forwarded = String(request.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map(normalizeAddress)
    .filter((item) => item && item !== "unknown");
  if (!forwarded.length) return { address:remoteAddress, source:"socket", trusted_proxy:true };
  // Walk from the immediate proxy towards the client. This avoids accepting a
  // spoofed left-most value when a trusted proxy appends the real peer address.
  const chain = [...forwarded, remoteAddress];
  let clientAddress = chain[0];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (trusted.has(chain[index])) continue;
    clientAddress = chain[index];
    break;
  }
  return { address:clientAddress, source:"x-forwarded-for", trusted_proxy:true };
}

const parseCookies = (header = "") => Object.fromEntries(String(header || "")
  .split(";")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const separator = item.indexOf("=");
    return separator > 0 ? [item.slice(0, separator), item.slice(separator + 1)] : [item, ""];
  }));

const sessionSecret = (env = process.env) => {
  for (const value of [env.HUAMEI_PUBLIC_SESSION_SECRET, env.HUAMEI_IDENTITY_PEPPER, env.HUAMEI_API_KEY]) {
    const candidate = String(value || "").trim();
    if (candidate.length >= 24 && candidate !== "hm_local_demo_key_2026") return candidate;
  }
  return LOCAL_SESSION_SECRET;
};

const signSessionPayload = (payload, env) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret(env)).update(`${SESSION_TOKEN_PREFIX}.${body}`).digest("base64url");
  return `${SESSION_TOKEN_PREFIX}.${body}.${signature}`;
};

const verifySessionToken = (token, env) => {
  const [prefix, body, signature, ...extra] = String(token || "").split(".");
  if (prefix !== SESSION_TOKEN_PREFIX || !body || !signature || extra.length) return { valid:false, code:"INVALID_SESSION_TOKEN" };
  const expected = createHmac("sha256", sessionSecret(env)).update(`${prefix}.${body}`).digest("base64url");
  if (!safeEqual(signature, expected)) return { valid:false, code:"INVALID_SESSION_TOKEN" };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.sid || !CANONICAL_PUBLIC_SESSION.test(payload.sid) || !payload.tenant_id || !payload.exp) {
      return { valid:false, code:"INVALID_SESSION_TOKEN" };
    }
    if (Date.now() >= Number(payload.exp) * 1_000) return { valid:false, code:"SESSION_TOKEN_EXPIRED" };
    return { valid:true, payload };
  } catch {
    return { valid:false, code:"INVALID_SESSION_TOKEN" };
  }
};

const publicSessionError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  error.status = 401;
  return error;
};

const nonceHash = (value = "") => value ? createHash("sha256").update(String(value)).digest("hex") : "";
const newSessionId = () => `ps_${randomBytes(24).toString("base64url")}`;
const legacyCompatibility = (env) => String(env.HUAMEI_PUBLIC_LEGACY_SESSION_COMPAT
  ?? (env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true";

const secureCookieFor = (request, client, env) => {
  if (env.HUAMEI_PUBLIC_COOKIE_SECURE !== undefined) {
    return String(env.HUAMEI_PUBLIC_COOKIE_SECURE).toLowerCase() === "true";
  }
  const forwardedProto = client.trusted_proxy ? String(request.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() : "";
  return request.socket?.encrypted === true || forwardedProto === "https";
};

export function resolvePublicSession(request, payload, tenantId, env = process.env) {
  const client = resolvePublicClientAddress(request, env);
  const requestedSessionId = String(payload?.session_id || "").trim().slice(0, 256);
  const explicitToken = String(
    request.headers?.["x-huamei-session-token"]
      || request.headers?.["x-session-token"]
      || payload?.session_token
      || parseCookies(request.headers?.cookie)[SESSION_COOKIE]
      || ""
  ).trim();
  const verified = explicitToken ? verifySessionToken(explicitToken, env) : { valid:false, code:"SESSION_CREDENTIAL_REQUIRED" };
  const requestedIsCanonical = CANONICAL_PUBLIC_SESSION.test(requestedSessionId);

  if (explicitToken && !verified.valid) {
    if (requestedIsCanonical || !requestedSessionId) {
      throw publicSessionError(verified.code, verified.code === "SESSION_TOKEN_EXPIRED" ? "会话凭证已过期，请重新开始咨询" : "会话凭证无效");
    }
  }
  if (verified.valid && verified.payload.tenant_id !== tenantId) {
    throw publicSessionError("SESSION_TENANT_MISMATCH", "会话凭证不属于当前租户");
  }
  if (verified.valid && requestedIsCanonical && requestedSessionId !== verified.payload.sid) {
    throw publicSessionError("SESSION_SCOPE_MISMATCH", "会话编号与会话凭证不匹配");
  }

  const requestedNonce = requestedIsCanonical ? "" : requestedSessionId;
  const nonceChanged = Boolean(
    verified.valid
      && requestedNonce
      && verified.payload.nonce_hash !== nonceHash(requestedNonce)
  );
  let sessionId;
  let credentialAccepted = false;
  if (verified.valid && !nonceChanged) {
    sessionId = verified.payload.sid;
    credentialAccepted = true;
  } else if (requestedIsCanonical) {
    throw publicSessionError("SESSION_CREDENTIAL_REQUIRED", "继续该会话需要有效的会话凭证");
  } else if (legacyCompatibility(env) && requestedNonce) {
    const userAgent = String(request.headers?.["user-agent"] || "unknown").slice(0, 240);
    const digest = createHmac("sha256", sessionSecret(env))
      .update(`legacy|${tenantId}|${client.address}|${userAgent}|${requestedNonce}`)
      .digest("base64url");
    sessionId = `ps_${digest.slice(0, 32)}`;
  } else {
    sessionId = newSessionId();
  }

  const lifetimeSeconds = Math.max(300, Math.min(Number(env.HUAMEI_PUBLIC_SESSION_TTL_SECONDS) || 1_800, 86_400));
  const issuedAt = Math.floor(Date.now() / 1_000);
  const tokenPayload = {
    v:1,
    sid:sessionId,
    tenant_id:tenantId,
    nonce_hash:requestedNonce ? nonceHash(requestedNonce) : verified.valid ? verified.payload.nonce_hash || "" : "",
    iat:issuedAt,
    exp:issuedAt + lifetimeSeconds
  };
  const sessionToken = credentialAccepted ? explicitToken : signSessionPayload(tokenPayload, env);
  const cookie = [
    `${SESSION_COOKIE}=${sessionToken}`,
    "Path=/api/public",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${lifetimeSeconds}`,
    secureCookieFor(request, client, env) ? "Secure" : ""
  ].filter(Boolean).join("; ");
  return {
    sessionId,
    sessionToken,
    expiresAt:new Date(tokenPayload.exp * 1_000).toISOString(),
    setCookie:cookie,
    client,
    rateIdentity:credentialAccepted ? `session:${sessionId}` : `bootstrap:${client.address}`,
    credentialAccepted,
    legacyMapped:!credentialAccepted && legacyCompatibility(env) && Boolean(requestedNonce)
  };
}
