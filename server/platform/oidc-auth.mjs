import { createPublicKey, verify as verifySignature } from "node:crypto";

const supportedAlgorithms = new Set(["RS256", "ES256"]);
const encoder = new TextEncoder();

const runtimeEnvironment = (env) => String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase();

const authError = (code, message, status = 401, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const decodeJsonPart = (part, name) => {
  try {
    return JSON.parse(Buffer.from(String(part), "base64url").toString("utf8"));
  } catch {
    throw authError("OIDC_TOKEN_MALFORMED", `OIDC token ${name} is not valid JSON`);
  }
};

const claimValues = (value) => {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return [];
};

const audienceMatches = (actual, expected) => {
  const values = Array.isArray(actual) ? actual.map(String) : [String(actual || "")];
  return values.includes(expected);
};

const normalizeHttpsUrl = (value, { production, field }) => {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw authError("OIDC_CONFIGURATION_INVALID", `${field} must be a valid URL`, 503); }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(loopback && !production && parsed.protocol === "http:")) {
    throw authError("OIDC_CONFIGURATION_INSECURE", `${field} must use HTTPS`, 503);
  }
  return parsed.toString().replace(/\/$/, "");
};

export function readOidcConfig(env = process.env) {
  const production = ["prod", "production"].includes(runtimeEnvironment(env));
  const issuer = String(env.HUAMEI_OIDC_ISSUER || "").trim().replace(/\/$/, "");
  const audience = String(env.HUAMEI_OIDC_AUDIENCE || "").trim();
  const jwksUrlValue = String(env.HUAMEI_OIDC_JWKS_URL || (issuer ? `${issuer}/.well-known/jwks.json` : "")).trim();
  const required = production || String(env.HUAMEI_OIDC_REQUIRED || "false").trim().toLowerCase() === "true";
  const configured = Boolean(issuer && audience && jwksUrlValue);
  if (required && !configured) {
    throw authError("OIDC_CONFIGURATION_REQUIRED", "Production requires OIDC issuer, audience and JWKS URL", 503);
  }
  return {
    production,
    required,
    configured,
    issuer:configured ? normalizeHttpsUrl(issuer, { production, field:"HUAMEI_OIDC_ISSUER" }) : "",
    audience,
    jwksUrl:configured ? normalizeHttpsUrl(jwksUrlValue, { production, field:"HUAMEI_OIDC_JWKS_URL" }) : "",
    roleClaim:String(env.HUAMEI_OIDC_ROLE_CLAIM || "roles").trim() || "roles",
    tenantClaim:String(env.HUAMEI_OIDC_TENANT_CLAIM || "tenant_ids").trim() || "tenant_ids",
    departmentClaim:String(env.HUAMEI_OIDC_DEPARTMENT_CLAIM || "department_ids").trim() || "department_ids",
    clockSkewSeconds:Math.min(Math.max(Number(env.HUAMEI_OIDC_CLOCK_SKEW_SECONDS) || 60, 0), 300),
    jwksCacheMs:Math.min(Math.max(Number(env.HUAMEI_OIDC_JWKS_CACHE_MS) || 5 * 60_000, 10_000), 60 * 60_000),
    fetchTimeoutMs:Math.min(Math.max(Number(env.HUAMEI_OIDC_FETCH_TIMEOUT_MS) || 3_000, 250), 10_000)
  };
}

const signatureOptions = (algorithm, key) => algorithm === "ES256"
  ? { key, dsaEncoding:"ieee-p1363" }
  : key;

export function createOidcVerifier(options = {}) {
  const env = options.env || process.env;
  const config = options.config || readOidcConfig(env);
  const fetchImpl = options.fetchImpl || fetch;
  const nowSeconds = options.nowSeconds || (() => Math.floor(Date.now() / 1_000));
  let cachedKeys = null;
  let cachedUntil = 0;
  let inFlight = null;

  const loadKeys = async ({ force = false } = {}) => {
    if (!config.configured) throw authError("OIDC_CONFIGURATION_REQUIRED", "OIDC is not configured", 503);
    const now = Date.now();
    if (!force && cachedKeys && now < cachedUntil) return cachedKeys;
    if (!force && inFlight) return inFlight;
    inFlight = (async () => {
      let response;
      try {
        response = await fetchImpl(config.jwksUrl, {
          headers:{ Accept:"application/json" },
          signal:AbortSignal.timeout(config.fetchTimeoutMs)
        });
      } catch (cause) {
        throw authError("OIDC_JWKS_UNAVAILABLE", "OIDC signing keys are unavailable", 503, [{ cause:String(cause?.code || cause?.name || "network") }]);
      }
      if (!response.ok) throw authError("OIDC_JWKS_UNAVAILABLE", "OIDC signing keys are unavailable", 503);
      let body;
      try { body = await response.json(); }
      catch { throw authError("OIDC_JWKS_INVALID", "OIDC JWKS response is invalid", 503); }
      if (!Array.isArray(body.keys) || !body.keys.length) {
        throw authError("OIDC_JWKS_INVALID", "OIDC JWKS has no signing keys", 503);
      }
      cachedKeys = body.keys.filter((item) => item && typeof item === "object");
      cachedUntil = Date.now() + config.jwksCacheMs;
      return cachedKeys;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const signingKey = async (header) => {
    const find = (keys) => keys.find((item) => item.kid === header.kid
      && (!item.alg || item.alg === header.alg)
      && (!item.use || item.use === "sig")
      && (!Array.isArray(item.key_ops) || item.key_ops.includes("verify")));
    let key = find(await loadKeys());
    if (!key) key = find(await loadKeys({ force:true }));
    if (!key) throw authError("OIDC_SIGNING_KEY_NOT_FOUND", "OIDC signing key was not found");
    try { return createPublicKey({ key, format:"jwk" }); }
    catch { throw authError("OIDC_SIGNING_KEY_INVALID", "OIDC signing key is invalid", 503); }
  };

  const verifyToken = async (token, requirements = {}) => {
    const compact = String(token || "").trim();
    if (!compact || compact.length > 16_384) throw authError("OIDC_TOKEN_MISSING", "Bearer token is required");
    const parts = compact.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw authError("OIDC_TOKEN_MALFORMED", "Bearer token is malformed");
    const header = decodeJsonPart(parts[0], "header");
    const claims = decodeJsonPart(parts[1], "claims");
    if (!supportedAlgorithms.has(header.alg) || !String(header.kid || "").trim()) {
      throw authError("OIDC_ALGORITHM_REJECTED", "OIDC token algorithm or key id is not allowed");
    }
    const key = await signingKey(header);
    let signatureValid = false;
    try {
      signatureValid = verifySignature(
        "SHA256",
        encoder.encode(`${parts[0]}.${parts[1]}`),
        signatureOptions(header.alg, key),
        Buffer.from(parts[2], "base64url")
      );
    } catch {}
    if (!signatureValid) throw authError("OIDC_SIGNATURE_INVALID", "OIDC token signature is invalid");

    const now = Number(nowSeconds());
    const skew = config.clockSkewSeconds;
    if (String(claims.iss || "").replace(/\/$/, "") !== config.issuer.replace(/\/$/, "")) {
      throw authError("OIDC_ISSUER_MISMATCH", "OIDC token issuer is invalid");
    }
    if (!audienceMatches(claims.aud, config.audience)) {
      throw authError("OIDC_AUDIENCE_MISMATCH", "OIDC token audience is invalid");
    }
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < now - skew) {
      throw authError("OIDC_TOKEN_EXPIRED", "OIDC token has expired");
    }
    if (claims.nbf !== undefined && Number(claims.nbf) > now + skew) {
      throw authError("OIDC_TOKEN_NOT_ACTIVE", "OIDC token is not active yet");
    }
    if (!String(claims.sub || "").trim()) throw authError("OIDC_SUBJECT_MISSING", "OIDC subject is missing");

    const roles = new Set(claimValues(claims[config.roleClaim]));
    const tenantIds = new Set(claimValues(claims[config.tenantClaim]));
    const departmentIds = new Set(claimValues(claims[config.departmentClaim]));
    const requiredRoles = claimValues(requirements.requiredRoles);
    if (requiredRoles.length && !requiredRoles.some((role) => roles.has(role))) {
      throw authError("OIDC_ROLE_FORBIDDEN", "OIDC identity does not have the required role", 403);
    }
    const requiredAllRoles = claimValues(requirements.requiredAllRoles);
    const missingRoles = requiredAllRoles.filter((role) => !roles.has(role));
    if (missingRoles.length) {
      throw authError(
        "OIDC_ROLE_FORBIDDEN",
        "OIDC identity does not have every required role",
        403,
        missingRoles.map((role) => ({ role }))
      );
    }
    const tenantId = String(requirements.tenantId || "").trim();
    if (tenantId && !tenantIds.has("*") && !tenantIds.has(tenantId)) {
      throw authError("OIDC_TENANT_FORBIDDEN", "OIDC identity is not authorized for this tenant", 403);
    }
    return {
      subject:String(claims.sub).slice(0, 160),
      displayName:String(claims.name || claims.preferred_username || claims.email || claims.sub).slice(0, 160),
      roles:[...roles],
      tenantIds:[...tenantIds],
      departmentIds:[...departmentIds],
      issuer:config.issuer,
      tokenId:claims.jti ? String(claims.jti).slice(0, 160) : null,
      authenticatedAt:new Date(now * 1_000).toISOString()
    };
  };

  const verifyAuthorizationHeader = (header, requirements = {}) => {
    const match = String(header || "").match(/^Bearer\s+(.+)$/i);
    if (!match) throw authError("OIDC_TOKEN_MISSING", "Bearer token is required");
    return verifyToken(match[1], requirements);
  };

  return {
    config,
    loadKeys,
    verifyToken,
    verifyAuthorizationHeader,
    clearCache() { cachedKeys = null; cachedUntil = 0; }
  };
}

let defaultVerifier;
export const getOidcVerifier = (options = {}) => {
  if (!defaultVerifier) defaultVerifier = createOidcVerifier(options);
  return defaultVerifier;
};

export const resetOidcVerifierForTest = () => { defaultVerifier = undefined; };
