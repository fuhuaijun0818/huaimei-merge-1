import { isAbsolute } from "node:path";

import { createPostgresClient } from "./postgres.mjs";
import { createRedisClient } from "./redis.mjs";
import { readOidcConfig } from "./oidc-auth.mjs";
import { FIELD_ENCRYPTION_KEYRING_ENV, validateFieldEncryptionKeyring } from "./field-encryption.mjs";
import {
  CONTACT_VAULT_KEYRING_ENV,
  validateContactVaultKeyring
} from "./contact-vault-encryption.mjs";
import {
  PRIVACY_VERIFICATION_SECRET_ENV,
  privacyVerificationConfiguration
} from "./privacy-identity-attestation.mjs";
import {
  PRIVACY_COMPLETION_SECRET_ENV,
  privacyCompletionConfiguration
} from "./privacy-completion-attestation.mjs";
import {
  PRIVACY_CANCELLATION_SECRET_ENV,
  privacyCancellationConfiguration
} from "./privacy-cancellation-attestation.mjs";

const LOCAL_STATE_VARIABLES = [
  "HUAMEI_ACQUISITION_SESSION_STORE_FILE",
  "HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE",
  "HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE",
  "HUAMEI_LEAD_STORE_FILE"
];

const environmentName = (env) => String(
  env.HUAMEI_RUNTIME_ENV
    || env.HUAMEI_DEPLOYMENT_ENV
    || env.NODE_ENV
    || "development"
).trim().toLowerCase();

const isProductionName = (value) => ["prod", "production"].includes(value);
const asBoolean = (value) => String(value || "false").trim().toLowerCase() === "true";
const issue = (code, field, message) => ({ code, field, message });
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_.:@/-]{1,127}$/i;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const ACQUISITION_PERMISSIONS = new Set([
  "service:read",
  "conversation:write",
  "operations:read",
  "operations:write",
  "knowledge:read",
  "knowledge:release",
  "privacy:request",
  "privacy:read",
  "privacy:process",
  "runs:read",
  "contact:reveal",
  "formal-load:execute"
]);

const validUrlProtocol = (value, protocols) => {
  try { return protocols.includes(new URL(value).protocol); }
  catch { return false; }
};

const looksPlaceholder = (value) => /replace[_-]with|change[_-]me|example\.(?:com|invalid|test)|placeholder/i.test(String(value || ""));
const looksWeakSecret = (value) => {
  const normalized = String(value || "").trim();
  return normalized.length < 32
    || looksPlaceholder(normalized)
    || /(?:^|[-_.])(password|passwd|changeme|change-me|123456(?:78)?|local-demo|demo-key)(?:$|[-_.])/i.test(normalized)
    || new Set(normalized).size < 8;
};
const urlUsername = (value) => {
  try { return decodeURIComponent(new URL(value).username || ""); }
  catch { return ""; }
};
const internalHostname = (value) => {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost"
    || hostname === "::1"
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    || /^(?:fc|fd)[0-9a-f:]+$/i.test(hostname)
    || /\.(?:internal|local|svc|cluster\.local)$/.test(hostname);
};
const loopbackOrPrivateAddress = (value) => {
  const address = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return address === "localhost" || address === "::1" || /^127\./.test(address)
    || /^10\./.test(address) || /^192\.168\./.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
    || /^(?:fc|fd)[0-9a-f:]+$/i.test(address);
};

export async function checkAdminIdentityProxyHealth(env = process.env, fetchImpl = fetch) {
  if (String(env.HUAMEI_PUBLIC_GATEWAY_ENABLED || "").trim().toLowerCase() !== "true") {
    return { ok:true, status:"not_required" };
  }
  const healthUrl = String(env.HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL || "").trim();
  try {
    const response = await fetchImpl(healthUrl, {
      method:"GET",
      headers:{ Accept:"application/json", "Cache-Control":"no-store" },
      redirect:"error",
      signal:AbortSignal.timeout(3_000)
    });
    const contract = String(response.headers.get("x-huamei-identity-proxy-contract") || "").trim();
    const ok = response.ok && contract === "oidc-code-pkce-v1";
    return { ok, status:ok ? "ready" : "contract_mismatch", status_code:response.status, contract:contract || null };
  } catch (error) {
    return { ok:false, status:"unavailable", error:String(error?.code || error?.name || "network") };
  }
}

/**
 * Parse the production service-to-service client registry without ever
 * deriving authorization from request supplied tenant data.  The returned
 * object is intentionally suitable for both startup validation and the
 * acquisition service authenticator; callers must not serialize `clients`
 * because each entry contains its authentication secret.
 */
export function parseAcquisitionClientsConfig(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return { configured:false, valid:false, clients:[], errors:[] };
  let decoded;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      configured:true,
      valid:false,
      clients:[],
      errors:[issue("ACQUISITION_CLIENTS_JSON_INVALID", "HUAMEI_ACQUISITION_CLIENTS_JSON", "Acquisition client registry must be valid JSON")]
    };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {
      configured:true,
      valid:false,
      clients:[],
      errors:[issue("ACQUISITION_CLIENTS_OBJECT_REQUIRED", "HUAMEI_ACQUISITION_CLIENTS_JSON", "Acquisition client registry must be a JSON object keyed by caller id")]
    };
  }
  const errors = [];
  const clients = [];
  const seenSecrets = new Set();
  for (const [callerId, definition] of Object.entries(decoded)) {
    const field = `HUAMEI_ACQUISITION_CLIENTS_JSON.${callerId}`;
    if (!CLIENT_ID_PATTERN.test(callerId)) {
      errors.push(issue("ACQUISITION_CALLER_ID_INVALID", field, "Caller id must contain 2-128 safe identifier characters"));
      continue;
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      errors.push(issue("ACQUISITION_CLIENT_DEFINITION_INVALID", field, "Client definition must be an object"));
      continue;
    }
    const secret = String(definition.secret || "").trim();
    if (looksWeakSecret(secret)) {
      errors.push(issue("ACQUISITION_CLIENT_SECRET_WEAK", `${field}.secret`, "Client secret must be an independently generated random value of at least 32 characters"));
    } else if (seenSecrets.has(secret)) {
      errors.push(issue("ACQUISITION_CLIENT_SECRET_REUSED", `${field}.secret`, "Each caller must use a distinct client secret"));
    }
    if (secret) seenSecrets.add(secret);

    const tenantIds = Array.isArray(definition.tenant_ids)
      ? [...new Set(definition.tenant_ids.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!tenantIds.length || tenantIds.some((tenantId) => !TENANT_ID_PATTERN.test(tenantId))) {
      errors.push(issue("ACQUISITION_CLIENT_TENANTS_INVALID", `${field}.tenant_ids`, "tenant_ids must explicitly list one or more valid tenant ids; wildcards are not allowed"));
    }

    const permissions = Array.isArray(definition.permissions)
      ? [...new Set(definition.permissions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!permissions.length || permissions.some((permission) => !ACQUISITION_PERMISSIONS.has(permission))) {
      errors.push(issue("ACQUISITION_CLIENT_PERMISSIONS_INVALID", `${field}.permissions`, "permissions must be a non-empty array of supported acquisition permissions"));
    }
    clients.push({ caller_id:callerId, secret, tenant_ids:tenantIds, permissions });
  }
  if (!clients.length) {
    errors.push(issue("ACQUISITION_CLIENT_REQUIRED", "HUAMEI_ACQUISITION_CLIENTS_JSON", "At least one acquisition client must be configured"));
  }
  return { configured:true, valid:errors.length === 0, clients, errors };
}

export function validateInfrastructureConfig(env = process.env, options = {}) {
  const environment = environmentName(env);
  const production = options.production ?? isProductionName(environment);
  const persistenceBackend = String(env.HUAMEI_PERSISTENCE_BACKEND || env.HUAMEI_PERSISTENCE_DRIVER || env.HUAMEI_STATE_BACKEND || "").trim().toLowerCase();
  const cacheBackend = String(env.HUAMEI_CACHE_BACKEND || env.HUAMEI_CACHE_DRIVER || env.HUAMEI_COORDINATION_BACKEND || "").trim().toLowerCase();
  const databaseUrl = String(env.HUAMEI_DATABASE_URL || env.DATABASE_URL || "").trim();
  const redisUrl = String(env.HUAMEI_REDIS_URL || env.REDIS_URL || "").trim();
  const fieldEncryption = validateFieldEncryptionKeyring(env[FIELD_ENCRYPTION_KEYRING_ENV]);
  const contactVault = validateContactVaultKeyring(env[CONTACT_VAULT_KEYRING_ENV], {
    disallowedKeyrings:[env[FIELD_ENCRYPTION_KEYRING_ENV]]
  });
  const privacyVerification = privacyVerificationConfiguration(env);
  const privacyCompletion = privacyCompletionConfiguration(env);
  const privacyCancellation = privacyCancellationConfiguration(env);
  let oidcConfiguration = null;
  const errors = [];
  const warnings = [];

  if (production) {
    if (persistenceBackend !== "postgres") {
      errors.push(issue("PRODUCTION_POSTGRES_REQUIRED", "HUAMEI_PERSISTENCE_BACKEND", "Production persistence backend must be postgres"));
    }
    if (!databaseUrl || !validUrlProtocol(databaseUrl, ["postgres:", "postgresql:"])) {
      errors.push(issue("PRODUCTION_DATABASE_URL_REQUIRED", "HUAMEI_DATABASE_URL", "Production requires a valid PostgreSQL connection URL"));
    } else if (looksPlaceholder(databaseUrl)) {
      errors.push(issue("PRODUCTION_DATABASE_SECRET_PLACEHOLDER", "HUAMEI_DATABASE_URL", "Replace the example PostgreSQL credential before deployment"));
    } else if (urlUsername(databaseUrl) !== "huamei_runtime") {
      errors.push(issue(
        "PRODUCTION_DATABASE_RUNTIME_ROLE_REQUIRED",
        "HUAMEI_DATABASE_URL",
        "Production application connections must use the least-privilege huamei_runtime role"
      ));
    }
    if (cacheBackend !== "redis") {
      errors.push(issue("PRODUCTION_REDIS_REQUIRED", "HUAMEI_CACHE_BACKEND", "Production cache and coordination backend must be redis"));
    }
    if (!redisUrl || !validUrlProtocol(redisUrl, ["redis:", "rediss:"])) {
      errors.push(issue("PRODUCTION_REDIS_URL_REQUIRED", "HUAMEI_REDIS_URL", "Production requires a valid Redis connection URL"));
    } else if (looksPlaceholder(redisUrl)) {
      errors.push(issue("PRODUCTION_REDIS_SECRET_PLACEHOLDER", "HUAMEI_REDIS_URL", "Replace the example Redis credential before deployment"));
    }
    for (const name of LOCAL_STATE_VARIABLES) {
      const value = String(env[name] || "").trim();
      if (value) {
        errors.push(issue("PRODUCTION_LOCAL_STATE_FORBIDDEN", name, `Production cannot use local state setting ${name}`));
      }
    }
    for (const name of ["HUAMEI_PERSISTENCE_DRIVER", "HUAMEI_SESSION_STORE_DRIVER", "HUAMEI_CACHE_DRIVER"]) {
      const value = String(env[name] || "").trim().toLowerCase();
      if (["memory", "local_json", "json", "file"].includes(value)) {
        errors.push(issue("PRODUCTION_LOCAL_ADAPTER_FORBIDDEN", name, `Production cannot use ${value} for ${name}`));
      }
    }
    if (asBoolean(env.HUAMEI_ACQUISITION_SERVICE_IN_PROCESS)) {
      errors.push(issue("PRODUCTION_IN_PROCESS_SERVICE_FORBIDDEN", "HUAMEI_ACQUISITION_SERVICE_IN_PROCESS", "Production acquisition service must run as an independent service"));
    }
    if (!fieldEncryption.configured) {
      errors.push(issue(
        "PRODUCTION_FIELD_ENCRYPTION_KEYRING_REQUIRED",
        FIELD_ENCRYPTION_KEYRING_ENV,
        "Production requires a versioned AES-256-GCM field encryption keyring"
      ));
    } else if (!fieldEncryption.valid) {
      for (const error of fieldEncryption.errors) {
        errors.push(issue(error.code, FIELD_ENCRYPTION_KEYRING_ENV, error.message));
      }
    }
    if (!contactVault.configured) {
      errors.push(issue(
        "PRODUCTION_CONTACT_VAULT_KEYRING_REQUIRED",
        CONTACT_VAULT_KEYRING_ENV,
        "Production requires an independent AES-256-GCM keyring for reversible contact data"
      ));
    } else if (!contactVault.valid) {
      for (const error of contactVault.errors) {
        errors.push(issue(error.code, CONTACT_VAULT_KEYRING_ENV, error.message));
      }
    }

    const llmEnabled = asBoolean(env.HUAMEI_LLM_ENABLED);
    const graphRagEnabled = asBoolean(env.HUAMEI_GRAPHRAG_ENABLED);
    const llmBaseUrl = String(env.HUAMEI_LLM_BASE_URL || "").trim();
    const llmApiKey = String(env.HUAMEI_LLM_API_KEY || "").trim();
    const llmModel = String(env.HUAMEI_LLM_MODEL || "").trim();
    const llmEgressApproved = asBoolean(env.HUAMEI_LLM_DATA_EGRESS_APPROVED);
    if (!llmEnabled) {
      errors.push(issue("PRODUCTION_LLM_REQUIRED", "HUAMEI_LLM_ENABLED", "Production must enable the approved language-model runtime; rules-only mode is not release-ready"));
    }
    let parsedLlmUrl = null;
    try { parsedLlmUrl = llmBaseUrl ? new URL(llmBaseUrl) : null; } catch {}
    if (!parsedLlmUrl || !["https:", "http:"].includes(parsedLlmUrl.protocol) || looksPlaceholder(llmBaseUrl)) {
      errors.push(issue("PRODUCTION_LLM_BASE_URL_INVALID", "HUAMEI_LLM_BASE_URL", "Production requires a non-placeholder HTTPS model endpoint or an explicitly approved internal HTTP endpoint"));
    } else if (parsedLlmUrl.protocol !== "https:") {
      const approvedInternal = internalHostname(parsedLlmUrl.hostname)
        && asBoolean(env.HUAMEI_LLM_INTERNAL_ENDPOINT_APPROVED);
      if (!approvedInternal) {
        errors.push(issue("PRODUCTION_LLM_HTTPS_REQUIRED", "HUAMEI_LLM_BASE_URL", "Non-HTTPS model endpoints must be private and explicitly approved with HUAMEI_LLM_INTERNAL_ENDPOINT_APPROVED=true"));
      }
    }
    if (looksWeakSecret(llmApiKey)
        || /^(?:sk[-_])?(?:unit[-_]?test|test|demo|example|placeholder)(?:[-_]|$)/i.test(llmApiKey)) {
      errors.push(issue("PRODUCTION_LLM_API_KEY_REQUIRED", "HUAMEI_LLM_API_KEY", "Production requires a non-placeholder model credential of at least 32 random characters"));
    }
    if (!llmModel || looksPlaceholder(llmModel) || /^(?:test|demo|example|placeholder)(?:[-_.]|$)/i.test(llmModel)) {
      errors.push(issue("PRODUCTION_LLM_MODEL_REQUIRED", "HUAMEI_LLM_MODEL", "Production requires an explicit non-placeholder local or external model name"));
    }
    if (!llmEgressApproved) {
      errors.push(issue("PRODUCTION_LLM_DATA_EGRESS_APPROVAL_REQUIRED", "HUAMEI_LLM_DATA_EGRESS_APPROVED", "Production model traffic requires an approved data-egress decision"));
    }
    if (graphRagEnabled && looksWeakSecret(env.HUAMEI_GRAPHRAG_SERVICE_KEY)) {
      errors.push(issue(
        "PRODUCTION_GRAPHRAG_SERVICE_KEY_REQUIRED",
        "HUAMEI_GRAPHRAG_SERVICE_KEY",
        "Production GraphRAG retrieval requires an independent random service key of at least 32 characters"
      ));
    }

    const strongSecretFields = [
      "HUAMEI_API_KEY",
      "HUAMEI_IDENTITY_PEPPER",
      "HUAMEI_PUBLIC_SESSION_SECRET",
      PRIVACY_VERIFICATION_SECRET_ENV,
      PRIVACY_COMPLETION_SECRET_ENV,
      PRIVACY_CANCELLATION_SECRET_ENV
    ];
    for (const name of strongSecretFields) {
      if (looksWeakSecret(env[name])) {
        errors.push(issue("PRODUCTION_STRONG_SECRET_REQUIRED", name, `${name} must be an independently generated random value of at least 32 characters`));
      }
    }
    if (!privacyVerification.configured) {
      errors.push(issue(
        "PRODUCTION_PRIVACY_VERIFICATION_SECRET_REQUIRED",
        PRIVACY_VERIFICATION_SECRET_ENV,
        "Production requires an independent trusted-adapter secret for DSR identity attestations"
      ));
    }
    if (!privacyCompletion.configured) {
      errors.push(issue(
        "PRODUCTION_PRIVACY_COMPLETION_SECRET_REQUIRED",
        PRIVACY_COMPLETION_SECRET_ENV,
        "Production requires an independent trusted-adapter secret for DSR execution and delivery attestations"
      ));
    }
    if (!privacyCancellation.configured) {
      errors.push(issue(
        "PRODUCTION_PRIVACY_CANCELLATION_SECRET_REQUIRED",
        PRIVACY_CANCELLATION_SECRET_ENV,
        "Production requires an independent trusted-adapter secret for verified subject-withdrawal attestations"
      ));
    }
    const acquisitionClients = parseAcquisitionClientsConfig(env.HUAMEI_ACQUISITION_CLIENTS_JSON);
    if (!acquisitionClients.configured) {
      errors.push(issue(
        "PRODUCTION_ACQUISITION_CLIENTS_REQUIRED",
        "HUAMEI_ACQUISITION_CLIENTS_JSON",
        "Production requires an explicit caller-to-tenant acquisition client registry"
      ));
    } else {
      errors.push(...acquisitionClients.errors);
    }
    const gatewayCallerId = String(env.HUAMEI_ACQUISITION_CALLER_ID || "").trim();
    const gatewayCallerSecret = String(env.HUAMEI_ACQUISITION_CALLER_SECRET || "").trim();
    if (!CLIENT_ID_PATTERN.test(gatewayCallerId)) {
      errors.push(issue("PRODUCTION_ACQUISITION_CALLER_ID_REQUIRED", "HUAMEI_ACQUISITION_CALLER_ID", "Production gateway must declare its fixed acquisition caller id"));
    }
    if (looksWeakSecret(gatewayCallerSecret)) {
      errors.push(issue("PRODUCTION_ACQUISITION_CALLER_SECRET_REQUIRED", "HUAMEI_ACQUISITION_CALLER_SECRET", "Production gateway must use a random caller secret of at least 32 characters"));
    }
    const gatewayClient = acquisitionClients.clients.find((client) => client.caller_id === gatewayCallerId);
    if (gatewayCallerId && acquisitionClients.configured && !gatewayClient) {
      errors.push(issue("PRODUCTION_ACQUISITION_CALLER_NOT_REGISTERED", "HUAMEI_ACQUISITION_CALLER_ID", "Gateway caller id is not registered in HUAMEI_ACQUISITION_CLIENTS_JSON"));
    } else if (gatewayClient && gatewayCallerSecret && gatewayClient.secret !== gatewayCallerSecret) {
      errors.push(issue("PRODUCTION_ACQUISITION_CALLER_SECRET_MISMATCH", "HUAMEI_ACQUISITION_CALLER_SECRET", "Gateway caller secret does not match its registered client"));
    }
    if (gatewayClient && !gatewayClient.permissions.includes("*")) {
      for (const permission of [
        "service:read", "conversation:write", "privacy:request",
        "operations:read", "operations:write", "contact:reveal"
      ]) {
        if (!gatewayClient.permissions.includes(permission)) {
          errors.push(issue("PRODUCTION_GATEWAY_PERMISSION_REQUIRED", "HUAMEI_ACQUISITION_CLIENTS_JSON", `Gateway caller requires ${permission}`));
        }
      }
    }
    if (gatewayClient?.permissions.includes("*") || gatewayClient?.permissions.includes("formal-load:execute")) {
      errors.push(issue(
        "PRODUCTION_GATEWAY_FORMAL_LOAD_PERMISSION_FORBIDDEN",
        "HUAMEI_ACQUISITION_CLIENTS_JSON",
        "The public/application gateway caller must never receive formal-load:execute or wildcard permissions"
      ));
    }
    if (asBoolean(env.HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED)) {
      const manifestPath = String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_PATH || "").trim();
      const manifestSha = String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256 || "").trim().toLowerCase();
      let trustedTaxonomySigners = {};
      try {
        trustedTaxonomySigners = JSON.parse(Buffer.from(
          String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64 || ""),
          "base64"
        ).toString("utf8"));
      } catch {}
      const formalLoadClients = acquisitionClients.clients.filter((client) => client.permissions.includes("formal-load:execute"));
      if (!isAbsolute(manifestPath)) {
        errors.push(issue("FORMAL_LOAD_TAXONOMY_MANIFEST_PATH_REQUIRED", "HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_PATH", "Enabled formal taxonomy load requires an absolute read-only manifest path"));
      }
      if (!/^[a-f0-9]{64}$/.test(manifestSha)) {
        errors.push(issue("FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256_REQUIRED", "HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256", "Enabled formal taxonomy load requires the approved manifest SHA-256"));
      }
      if (!trustedTaxonomySigners || typeof trustedTaxonomySigners !== "object" || Array.isArray(trustedTaxonomySigners)
        || !Object.keys(trustedTaxonomySigners).length) {
        errors.push(issue("FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_REQUIRED", "HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64", "Enabled formal taxonomy load requires a dedicated external Ed25519 signer registry"));
      }
      if (!formalLoadClients.length || formalLoadClients.some((client) => client.caller_id === gatewayCallerId)) {
        errors.push(issue("FORMAL_LOAD_TAXONOMY_DEDICATED_CALLER_REQUIRED", "HUAMEI_ACQUISITION_CLIENTS_JSON", "Enabled formal taxonomy load requires at least one non-gateway caller with formal-load:execute"));
      }
    }
    const publicTenantId = String(env.HUAMEI_PUBLIC_TENANT_ID || env.HUAMEI_DEFAULT_TENANT_ID || "").trim().toLowerCase();
    if (!TENANT_ID_PATTERN.test(publicTenantId)) {
      errors.push(issue("PRODUCTION_PUBLIC_TENANT_REQUIRED", "HUAMEI_PUBLIC_TENANT_ID", "Production public gateway must bind to one valid tenant id"));
    } else if (gatewayClient && !gatewayClient.tenant_ids.includes("*") && !gatewayClient.tenant_ids.includes(publicTenantId)) {
      errors.push(issue("PRODUCTION_PUBLIC_TENANT_NOT_ALLOWED", "HUAMEI_PUBLIC_TENANT_ID", "Public tenant is not allowed for the configured gateway caller"));
    }
    const acquisitionTenantId = String(env.HUAMEI_ACQUISITION_TENANT_ID || publicTenantId).trim().toLowerCase();
    if (!TENANT_ID_PATTERN.test(acquisitionTenantId)) {
      errors.push(issue("PRODUCTION_ACQUISITION_TENANT_REQUIRED", "HUAMEI_ACQUISITION_TENANT_ID", "Production gateway client must bind to one valid acquisition tenant id"));
    } else if (acquisitionTenantId !== publicTenantId) {
      errors.push(issue("PRODUCTION_GATEWAY_TENANT_MISMATCH", "HUAMEI_ACQUISITION_TENANT_ID", "Gateway service tenant must match its fixed public tenant"));
    } else if (gatewayClient && !gatewayClient.tenant_ids.includes("*") && !gatewayClient.tenant_ids.includes(acquisitionTenantId)) {
      errors.push(issue("PRODUCTION_ACQUISITION_TENANT_NOT_ALLOWED", "HUAMEI_ACQUISITION_TENANT_ID", "Gateway service tenant is not allowed for the configured caller"));
    }
    const publicGatewaySetting = String(env.HUAMEI_PUBLIC_GATEWAY_ENABLED || "").trim().toLowerCase();
    if (!["true", "false"].includes(publicGatewaySetting)) {
      errors.push(issue(
        "PRODUCTION_PUBLIC_GATEWAY_ROLE_REQUIRED",
        "HUAMEI_PUBLIC_GATEWAY_ENABLED",
        "Every production service must explicitly declare whether it accepts public gateway traffic"
      ));
    } else if (publicGatewaySetting === "true") {
      if (String(env.HUAMEI_ADMIN_BROWSER_AUTH_MODE || "").trim() !== "external_oidc_pkce_proxy") {
        errors.push(issue(
          "PRODUCTION_ADMIN_BROWSER_AUTH_REQUIRED",
          "HUAMEI_ADMIN_BROWSER_AUTH_MODE",
          "Production browser administration requires a supported external OIDC authorization-code/PKCE proxy"
        ));
      }
      if (String(env.HUAMEI_ADMIN_IDENTITY_PROXY_SESSION_BACKEND || "").trim() !== "redis") {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_REDIS_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_SESSION_BACKEND",
          "The external OIDC proxy must keep encrypted browser sessions in shared Redis"
        ));
      }
      const identityProxyProduct = String(env.HUAMEI_ADMIN_IDENTITY_PROXY_PRODUCT || "").trim().toLowerCase();
      if (!new Set(["oauth2-proxy", "pomerium", "cloudflare-access", "azure-app-proxy"]).has(identityProxyProduct)) {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_PRODUCT_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_PRODUCT",
          "Select and record one supported deployed OIDC identity proxy product"
        ));
      }
      const identityProxyHealthUrl = String(env.HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL || "").trim();
      if (!validUrlProtocol(identityProxyHealthUrl, ["https:"]) || looksPlaceholder(identityProxyHealthUrl)) {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_HEALTH_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL",
          "Configure the approved HTTPS proxy health endpoint returning X-Huamei-Identity-Proxy-Contract: oidc-code-pkce-v1"
        ));
      }
      if (String(env.HUAMEI_ADMIN_IDENTITY_PROXY_UPSTREAM_AUTHORIZATION_MODE || "").trim() !== "overwrite_verified_bearer") {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_BEARER_OVERWRITE_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_UPSTREAM_AUTHORIZATION_MODE",
          "Identity proxy must discard caller Authorization and inject only its verified OIDC Bearer"
        ));
      }
      if (String(env.HUAMEI_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE || "").trim() !== "state_nonce_pkce_origin_logout") {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE",
          "Identity proxy must enforce state, nonce, PKCE, Origin/CSRF and OIDC logout"
        ));
      }
      if (!Number.isInteger(Number(env.HUAMEI_ADMIN_IDENTITY_PROXY_HA_REPLICAS)) || Number(env.HUAMEI_ADMIN_IDENTITY_PROXY_HA_REPLICAS) < 2) {
        errors.push(issue(
          "PRODUCTION_ADMIN_IDENTITY_PROXY_HA_REQUIRED",
          "HUAMEI_ADMIN_IDENTITY_PROXY_HA_REPLICAS",
          "Production identity proxy requires at least two replicas or equivalent managed HA"
        ));
      }
      const edgeBindAddress = String(env.HUAMEI_EDGE_BIND_ADDRESS || "").trim();
      if (!loopbackOrPrivateAddress(edgeBindAddress) || ["0.0.0.0", "::", "*"].includes(edgeBindAddress)) {
        errors.push(issue(
          "PRODUCTION_EDGE_PRIVATE_BIND_REQUIRED",
          "HUAMEI_EDGE_BIND_ADDRESS",
          "Caddy must bind only to loopback or an approved private edge address, never all interfaces"
        ));
      }
      const adminOrigin = String(env.HUAMEI_ADMIN_ORIGIN || "").trim();
      if (!validUrlProtocol(adminOrigin, ["https:"]) || looksPlaceholder(adminOrigin) || new URL(adminOrigin).pathname !== "/") {
        errors.push(issue(
          "PRODUCTION_ADMIN_ORIGIN_REQUIRED",
          "HUAMEI_ADMIN_ORIGIN",
          "Configure the exact HTTPS management origin for CSRF enforcement"
        ));
      } else {
        const allowedOrigins = String(env.HUAMEI_ALLOWED_ORIGINS || "")
          .split(",")
          .map((value) => value.trim().replace(/\/$/, ""))
          .filter(Boolean);
        if (!allowedOrigins.includes(adminOrigin.replace(/\/$/, ""))) {
          errors.push(issue(
            "PRODUCTION_ADMIN_ORIGIN_NOT_ALLOWED",
            "HUAMEI_ALLOWED_ORIGINS",
            "HUAMEI_ALLOWED_ORIGINS must include the exact management origin"
          ));
        }
      }
      const proxyAddresses = String(env.HUAMEI_TRUSTED_PROXY_ADDRESSES || "")
        .split(/[\s,]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (!asBoolean(env.HUAMEI_TRUST_PROXY)) {
        errors.push(issue(
          "PRODUCTION_TRUST_PROXY_REQUIRED",
          "HUAMEI_TRUST_PROXY",
          "A production public gateway behind the edge proxy must enable explicit immediate-proxy trust"
        ));
      }
      if (!proxyAddresses.length || proxyAddresses.some((value) => ["*", "0.0.0.0", "::", "unknown"].includes(value))) {
        errors.push(issue(
          "PRODUCTION_TRUSTED_PROXY_ADDRESSES_REQUIRED",
          "HUAMEI_TRUSTED_PROXY_ADDRESSES",
          "Configure one or more exact immediate proxy addresses; wildcard or whole-world trust is forbidden"
        ));
      }
    }
    const independentSecrets = [
      env.HUAMEI_API_KEY,
      env.HUAMEI_IDENTITY_PEPPER,
      env.HUAMEI_PUBLIC_SESSION_SECRET,
      env[PRIVACY_VERIFICATION_SECRET_ENV],
      env[PRIVACY_COMPLETION_SECRET_ENV],
      env[PRIVACY_CANCELLATION_SECRET_ENV],
      gatewayCallerSecret,
      ...(graphRagEnabled ? [env.HUAMEI_GRAPHRAG_SERVICE_KEY] : [])
    ].map((value) => String(value || "").trim()).filter(Boolean);
    if (new Set(independentSecrets).size !== independentSecrets.length) {
      errors.push(issue("PRODUCTION_SECRET_REUSE_FORBIDDEN", "HUAMEI_*_SECRET", "API, identity, session and service caller secrets must be independent"));
    }
    try {
      const oidc = readOidcConfig(env);
      oidcConfiguration = oidc;
      if (!oidc.configured) {
        errors.push(issue("PRODUCTION_OIDC_REQUIRED", "HUAMEI_OIDC_ISSUER", "Production requires an OIDC issuer, audience and JWKS endpoint for human approvals and administration"));
      }
    } catch (error) {
      errors.push(issue(error.code || "PRODUCTION_OIDC_INVALID", "HUAMEI_OIDC_ISSUER", error.message || "Production OIDC configuration is invalid"));
    }
  } else {
    if (persistenceBackend && persistenceBackend !== "postgres") {
      warnings.push(issue("LOCAL_PERSISTENCE_ONLY", "HUAMEI_PERSISTENCE_BACKEND", "Local JSON or memory persistence is for development only"));
    }
    if (cacheBackend && cacheBackend !== "redis") {
      warnings.push(issue("LOCAL_CACHE_ONLY", "HUAMEI_CACHE_BACKEND", "Process-local cache cannot coordinate multiple replicas"));
    }
  }

  const report = {
    ok:errors.length === 0,
    ready:errors.length === 0,
    production,
    environment,
    backends:{
      persistence:persistenceBackend || "unspecified",
      cache:cacheBackend || "unspecified",
      postgres_configured:Boolean(databaseUrl),
      redis_configured:Boolean(redisUrl),
      field_encryption_configured:fieldEncryption.configured && fieldEncryption.valid,
      contact_vault_encryption_configured:contactVault.configured && contactVault.valid,
      contact_vault_key_domain_independent:contactVault.independent === true,
      contact_capture_mode:"format_validation_pending_manual",
      privacy_verification_configured:privacyVerification.configured,
      privacy_completion_configured:privacyCompletion.configured,
      llm_enabled:asBoolean(env.HUAMEI_LLM_ENABLED),
      llm_configured:Boolean(env.HUAMEI_LLM_BASE_URL && env.HUAMEI_LLM_API_KEY && env.HUAMEI_LLM_MODEL),
      llm_data_egress_approved:asBoolean(env.HUAMEI_LLM_DATA_EGRESS_APPROVED),
      management_oidc_configured:oidcConfiguration?.configured === true,
      management_oidc_role_claim:oidcConfiguration?.roleClaim || null,
      management_oidc_tenant_claim:oidcConfiguration?.tenantClaim || null,
      management_human_tenant_wildcard_allowed:false
    },
    errors,
    warnings,
    checked_at:new Date().toISOString()
  };
  if (options.throwOnError && !report.ready) {
    const error = new Error(`Production infrastructure preflight failed: ${errors.map((item) => item.code).join(", ")}`);
    error.code = "PRODUCTION_INFRASTRUCTURE_NOT_READY";
    error.details = errors;
    error.report = report;
    throw error;
  }
  return report;
}

export const assertProductionInfrastructure = (env = process.env, options = {}) => validateInfrastructureConfig(env, {
  ...options,
  throwOnError:true
});

export function createProductionReadiness(options = {}) {
  const env = options.env || process.env;
  const postgres = options.postgres || createPostgresClient({ env, ...(options.postgresOptions || {}) });
  const redis = options.redis || createRedisClient({ env, ...(options.redisOptions || {}) });
  const fetchImpl = options.fetchImpl || fetch;

  const validate = (validationOptions = {}) => validateInfrastructureConfig(env, validationOptions);
  const assert = (validationOptions = {}) => assertProductionInfrastructure(env, validationOptions);
  const health = async () => {
    const configuration = validate();
    const [postgresHealth, redisHealth, identityProxyHealth] = await Promise.all([
      postgres.health(),
      redis.health(),
      checkAdminIdentityProxyHealth(env, fetchImpl)
    ]);
    let contactVaultHealth = {
      ok:false,
      status:"not_ready",
      storage:"postgres",
      encryption:configuration.backends.contact_vault_encryption_configured ? "aes-256-gcm-envelope" : "missing"
    };
    if (postgresHealth.ok && configuration.backends.contact_vault_encryption_configured
        && typeof postgres.tenantQuery === "function") {
      try {
        const tenantId = String(env.HUAMEI_PUBLIC_TENANT_ID || env.HUAMEI_DEFAULT_TENANT_ID || "").trim().toLowerCase();
        const relation = await postgres.tenantQuery(
          tenantId,
          "SELECT to_regclass('public.contact_vault_entries')::text AS relation",
          []
        );
        const exists = relation.rows[0]?.relation === "contact_vault_entries";
        contactVaultHealth = {
          ok:exists,
          status:exists ? "ready" : "not_ready",
          storage:"postgres",
          encryption:"aes-256-gcm-envelope"
        };
      } catch {
        contactVaultHealth = {
          ok:false,
          status:"not_ready",
          storage:"postgres",
          encryption:"aes-256-gcm-envelope"
        };
      }
    }
    const dependenciesReady = postgresHealth.ok && redisHealth.ok
      && identityProxyHealth.ok && contactVaultHealth.ok;
    return {
      ok:configuration.ready && dependenciesReady,
      status:configuration.ready && dependenciesReady ? "ready" : "not_ready",
      configuration,
      dependencies:{
        postgres:postgresHealth,
        redis:redisHealth,
        admin_identity_proxy:identityProxyHealth,
        contact_vault:contactVaultHealth
      },
      checked_at:new Date().toISOString()
    };
  };
  const close = async () => {
    const results = await Promise.allSettled([postgres.close(), redis.close()]);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
  };
  return { validate, assert, health, close, postgres, redis };
}

export const createInfrastructurePreflight = createProductionReadiness;
