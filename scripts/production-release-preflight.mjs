import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresClient } from "../server/platform/postgres.mjs";
import { createRedisClient } from "../server/platform/redis.mjs";
import { validateFieldEncryptionKeyring } from "../server/platform/field-encryption.mjs";
import { validateContactVaultKeyring } from "../server/platform/contact-vault-encryption.mjs";
import {
  POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS,
  POSTGRES_RUNTIME_CALLABLE_FUNCTIONS,
  postgresRuntimeTablePrivilegeMap
} from "../server/platform/postgres-object-acl-policy.mjs";
import {
  LEGACY_FIELD_ENVELOPE_MARKER,
  legacyFieldEnvelopeInventorySql,
  summarizeLegacyFieldEnvelopeInventory
} from "./migrate-field-envelopes-v2.mjs";
import {
  FORMAL_EVIDENCE_AUTHORITY_BY_KIND,
  trustedSignerRegistryFromEnv,
  verifyEvidenceDocumentAttestation
} from "./formal-evidence-common.mjs";
import {
  CAPACITY_ATTESTATION_SCHEMA,
  PROMETHEUS_CAPACITY_EXPORT_SCHEMA,
  RAW_CAPACITY_SCHEMA,
  productionCapacityBindingFromEnv,
  validateCapacityAttestation,
  validatePrometheusCapacityExport,
  validateRawCapacityReport
} from "./formal-capacity-evidence.mjs";
import {
  loadFormalEvaluationEndpointTarget,
  productionEvaluationBindingFromEnv,
  validateFormalEvaluationEndpointTarget
} from "./formal-production-evaluation.mjs";

export const RELEASE_PREFLIGHT_SCHEMA = "huamei.production-release-preflight.v1";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultMigrationsRoot = join(projectRoot, "db", "migrations");
const sha256Pattern = /^[0-9a-f]{64}$/;
const tenantIdPattern = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const immutableImagePattern = /^[^\s@]+@sha256:[0-9a-f]{64}$/i;
const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,191}$/;
const evidenceSchema = {
  evaluation:"huamei.production-evaluation-evidence.v3",
  capacity:"huamei.production-capacity-evidence.v2"
};
const formalSourceSpecs = Object.freeze([
  {
    name:"blind_dataset",
    evidenceKind:"blind_dataset",
    schema:"huamei.production-blind-evaluation-set.v1",
    report:"evaluation",
    pathField:"HUAMEI_FORMAL_BLIND_DATASET_PATH",
    digestField:"HUAMEI_FORMAL_BLIND_DATASET_SHA256"
  },
  {
    name:"evaluation_raw",
    evidenceKind:"evaluation_raw",
    schema:"huamei.production-evaluation-raw.v1",
    report:"evaluation",
    pathField:"HUAMEI_FORMAL_EVALUATION_RAW_PATH",
    digestField:"HUAMEI_FORMAL_EVALUATION_RAW_SHA256"
  },
  {
    name:"evaluation_scorecard",
    evidenceKind:"evaluation_scorecard",
    schema:"huamei.production-evaluation-scorecard.v1",
    report:"evaluation",
    pathField:"HUAMEI_FORMAL_EVALUATION_SCORECARD_PATH",
    digestField:"HUAMEI_FORMAL_EVALUATION_SCORECARD_SHA256"
  },
  {
    name:"capacity_raw",
    evidenceKind:"capacity_raw",
    schema:RAW_CAPACITY_SCHEMA,
    report:"capacity",
    pathField:"HUAMEI_FORMAL_CAPACITY_RAW_PATH",
    digestField:"HUAMEI_FORMAL_CAPACITY_RAW_SHA256"
  },
  {
    name:"capacity_observability_attestation",
    evidenceKind:"capacity_observability_attestation",
    schema:CAPACITY_ATTESTATION_SCHEMA,
    report:"capacity",
    pathField:"HUAMEI_FORMAL_CAPACITY_ATTESTATION_PATH",
    digestField:"HUAMEI_FORMAL_CAPACITY_ATTESTATION_SHA256"
  }
]);
const formalAuxiliarySpecs = Object.freeze([
  {
    name:"capacity_prometheus",
    schema:PROMETHEUS_CAPACITY_EXPORT_SCHEMA,
    pathField:"HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH",
    digestField:"HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256"
  }
]);
const formalReportSpecs = Object.freeze([
  {
    name:"evaluation",
    pathField:"HUAMEI_RELEASE_EVALUATION_REPORT_PATH",
    digestField:"HUAMEI_RELEASE_EVALUATION_REPORT_SHA256"
  },
  {
    name:"capacity",
    pathField:"HUAMEI_RELEASE_CAPACITY_REPORT_PATH",
    digestField:"HUAMEI_RELEASE_CAPACITY_REPORT_SHA256"
  }
]);
const reviewTypes = ["business", "medical", "compliance"];
export const tenantTables = [
  "tenants", "conversation_sessions", "conversation_messages", "leads", "lead_candidates", "consents",
  "handovers", "tasks", "human_work", "knowledge_releases", "knowledge_reviews",
  "audit_events", "outbox_events", "idempotency_records", "agent_runs",
  "data_migration_batches", "data_subject_requests", "contact_suppressions",
  "privacy_execution_actions", "privacy_identity_verifications", "privacy_completion_verifications",
  "contact_vault_entries", "agent_turn_results", "agent_effect_ledger", "agent_turn_leases", "appointment_sessions"
];

const sha256 = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right, "en")))
  : item);
const validSha256 = (value) => sha256Pattern.test(String(value || "").trim().toLowerCase());
const normalizedBoolean = (value) => String(value || "false").trim().toLowerCase() === "true";
const looksPlaceholder = (value) => /(?:replace|placeholder|changeme|example|dummy|fake|test[-_ ]?(?:key|secret)|not[-_ ]?printed)/i.test(String(value || ""));
const strongCredential = (value) => {
  const normalized = String(value || "").trim();
  return normalized.length >= 32
    && new Set(normalized).size >= 8
    && !/\s/.test(normalized)
    && !looksPlaceholder(normalized);
};
const safeReference = (value) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,191}$/.test(String(value || "").trim());
const httpsHost = (value) => {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
};
const safeCode = (error, fallback) => {
  const candidate = String(error?.code || fallback || "RELEASE_PREFLIGHT_FAILED").toUpperCase();
  return /^[A-Z0-9_.:-]{2,96}$/.test(candidate) ? candidate : String(fallback || "RELEASE_PREFLIGHT_FAILED");
};
const check = (name, ok, code, summary, details = {}) => ({
  name,
  status:ok ? "pass" : "blocked",
  ...(!ok ? { code } : {}),
  summary,
  details
});
const blockedFromError = (name, code, summary, error) => check(
  name,
  false,
  safeCode(error, code),
  summary,
  { dependency_error_code:safeCode(error, "UNKNOWN_DEPENDENCY_ERROR") }
);

export const parseReleaseTenants = (env = process.env) => [...new Set(String(
  env.HUAMEI_RELEASE_TENANT_IDS
    || env.HUAMEI_CONVERSATION_RECOVERY_TENANT_IDS
    || env.HUAMEI_PUBLIC_TENANT_ID
    || ""
).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];

export async function loadMigrationInventory(migrationsRoot = defaultMigrationsRoot) {
  const names = (await readdir(migrationsRoot))
    .filter((name) => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(names.map(async (name) => ({
    name,
    checksum:sha256(await readFile(join(migrationsRoot, name), "utf8"))
  })));
}

export function validateMigrationInventory(expected, appliedRows) {
  const expectedMap = new Map(expected.map((item) => [item.name, item.checksum]));
  const appliedMap = new Map((appliedRows || []).map((item) => [String(item.name), String(item.checksum)]));
  const missing = [...expectedMap.keys()].filter((name) => !appliedMap.has(name));
  const unexpected = [...appliedMap.keys()].filter((name) => !expectedMap.has(name));
  const mismatched = [...expectedMap].filter(([name, checksum]) => appliedMap.has(name) && appliedMap.get(name) !== checksum)
    .map(([name]) => name);
  return {
    ok:expected.length > 0 && !missing.length && !unexpected.length && !mismatched.length,
    expected_count:expected.length,
    applied_count:appliedMap.size,
    missing,
    unexpected,
    mismatched
  };
}

export function validateReleaseConfiguration(env = process.env) {
  const failures = [];
  const releaseId = String(env.HUAMEI_RELEASE_ID || "").trim();
  const evidenceEnvironment = String(env.HUAMEI_EVIDENCE_ENVIRONMENT || env.HUAMEI_DEPLOYMENT_ENV || env.HUAMEI_RUNTIME_ENV || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(releaseId)) failures.push("RELEASE_ID_REQUIRED");
  if (!["preproduction", "production"].includes(evidenceEnvironment)) failures.push("FORMAL_EVIDENCE_ENVIRONMENT_REQUIRED");
  for (const field of [
    "HUAMEI_APP_IMAGE", "HUAMEI_GRAPHRAG_IMAGE", "HUAMEI_POSTGRES_IMAGE",
    "HUAMEI_REDIS_IMAGE", "HUAMEI_CADDY_IMAGE"
  ]) {
    if (!immutableImagePattern.test(String(env[field] || "").trim())) failures.push(`${field}_MUST_USE_DIGEST`);
  }
  if (String(env.LITELLM_LOCAL_MODEL_COST_MAP || "").trim().toLowerCase() !== "true") {
    failures.push("LITELLM_LOCAL_MODEL_COST_MAP_REQUIRED");
  }
  if (String(env.HUAMEI_CANARY_TOKEN || "").trim().length < 32) failures.push("CANARY_TOKEN_REQUIRED");
  const tenants = parseReleaseTenants(env);
  if (!tenants.length || tenants.some((tenantId) => !tenantIdPattern.test(tenantId))) {
    failures.push("RELEASE_TENANTS_INVALID");
  }
  if (tenants.length > 1) failures.push("MULTI_TENANT_GRAPHRAG_ENDPOINT_MAPPING_REQUIRED");
  if (!safeReference(env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID)) failures.push("ACTIVE_KNOWLEDGE_RELEASE_ID_REQUIRED");

  const llmProvider = String(env.HUAMEI_LLM_PROVIDER || "").trim();
  const llmModel = String(env.HUAMEI_LLM_MODEL || "").trim();
  const llmHost = httpsHost(env.HUAMEI_LLM_BASE_URL);
  const graphProvider = String(env.GRAPHRAG_MODEL_PROVIDER || "").trim();
  const graphHost = httpsHost(env.GRAPHRAG_API_BASE);
  if (!normalizedBoolean(env.HUAMEI_LLM_ENABLED)) failures.push("PRODUCTION_LLM_MUST_BE_ENABLED");
  if (!modelNamePattern.test(llmProvider) || looksPlaceholder(llmProvider)) failures.push("PRODUCTION_LLM_PROVIDER_REQUIRED");
  if (!llmHost) failures.push("PRODUCTION_LLM_HTTPS_ENDPOINT_REQUIRED");
  if (!strongCredential(env.HUAMEI_LLM_API_KEY)) failures.push("PRODUCTION_LLM_KEY_REQUIRED");
  if (!modelNamePattern.test(llmModel) || looksPlaceholder(llmModel)) failures.push("PRODUCTION_LLM_MODEL_REQUIRED");
  if (!modelNamePattern.test(graphProvider) || looksPlaceholder(graphProvider)) failures.push("GRAPHRAG_MODEL_PROVIDER_REQUIRED");
  if (!graphHost) failures.push("GRAPHRAG_MODEL_HTTPS_ENDPOINT_REQUIRED");
  if (!strongCredential(env.GRAPHRAG_API_KEY)) failures.push("GRAPHRAG_MODEL_KEY_REQUIRED");
  if (!strongCredential(env.HUAMEI_GRAPHRAG_SERVICE_KEY)) failures.push("GRAPHRAG_SERVICE_KEY_REQUIRED");
  if (!strongCredential(env.HUAMEI_ACQUISITION_METRICS_TOKEN)) failures.push("ACQUISITION_METRICS_TOKEN_REQUIRED");
  if (!strongCredential(env.HUAMEI_OUTBOX_METRICS_TOKEN)) failures.push("OUTBOX_METRICS_TOKEN_REQUIRED");
  if (!strongCredential(env.HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN)) failures.push("CONVERSATION_RECOVERY_METRICS_TOKEN_REQUIRED");
  if (!strongCredential(env.HUAMEI_PRIVACY_VERIFICATION_SECRET)) failures.push("PRIVACY_VERIFICATION_SECRET_REQUIRED");
  if (!strongCredential(env.HUAMEI_PRIVACY_COMPLETION_SECRET)) failures.push("PRIVACY_COMPLETION_SECRET_REQUIRED");
  if (!strongCredential(env.HUAMEI_PRIVACY_CANCELLATION_SECRET)) failures.push("PRIVACY_CANCELLATION_SECRET_REQUIRED");
  for (const [field, value] of [
    ["GRAPHRAG_COMPLETION_MODEL", env.GRAPHRAG_COMPLETION_MODEL],
    ["GRAPHRAG_EMBEDDING_MODEL", env.GRAPHRAG_EMBEDDING_MODEL]
  ]) {
    if (!modelNamePattern.test(String(value || "").trim()) || looksPlaceholder(value)) failures.push(`${field}_REQUIRED`);
  }
  if (!safeReference(env.HUAMEI_GRAPHRAG_INDEX_VERSION)) failures.push("GRAPHRAG_INDEX_VERSION_REQUIRED");
  if (!validSha256(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256)) failures.push("GRAPHRAG_MANIFEST_SHA256_REQUIRED");
  const independentSecrets = [
    env.HUAMEI_LLM_API_KEY,
    env.GRAPHRAG_API_KEY,
    env.HUAMEI_API_KEY,
    env.HUAMEI_ACQUISITION_CALLER_SECRET,
    env.HUAMEI_GRAPHRAG_SERVICE_KEY,
    env.HUAMEI_IDENTITY_PEPPER,
    env.HUAMEI_PUBLIC_SESSION_SECRET,
    env.HUAMEI_PRIVACY_VERIFICATION_SECRET,
    env.HUAMEI_PRIVACY_COMPLETION_SECRET,
    env.HUAMEI_PRIVACY_CANCELLATION_SECRET,
    env.HUAMEI_ACQUISITION_METRICS_TOKEN,
    env.HUAMEI_OUTBOX_METRICS_TOKEN,
    env.HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (new Set(independentSecrets).size !== independentSecrets.length) failures.push("PRODUCTION_SECRET_REUSE_FORBIDDEN");

  if (!normalizedBoolean(env.HUAMEI_LLM_DATA_EGRESS_APPROVED)) failures.push("MODEL_DATA_EGRESS_APPROVAL_REQUIRED");
  if (!safeReference(env.HUAMEI_LLM_DATA_EGRESS_APPROVAL_ID)) failures.push("MODEL_DATA_EGRESS_APPROVAL_ID_REQUIRED");
  const approvedHosts = new Set(String(env.HUAMEI_APPROVED_MODEL_EGRESS_HOSTS || "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!approvedHosts.size || [...approvedHosts].some((host) => !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host))) {
    failures.push("APPROVED_MODEL_EGRESS_HOSTS_INVALID");
  }
  if (llmHost && !approvedHosts.has(llmHost)) failures.push("LLM_EGRESS_HOST_NOT_APPROVED");
  if (graphHost && !approvedHosts.has(graphHost)) failures.push("GRAPHRAG_EGRESS_HOST_NOT_APPROVED");

  const fieldEncryption = validateFieldEncryptionKeyring(env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON);
  if (!fieldEncryption.configured) failures.push("FIELD_ENCRYPTION_KEYRING_REQUIRED");
  else if (!fieldEncryption.valid) failures.push(...fieldEncryption.errors.map((error) => error.code));
  const contactVault = validateContactVaultKeyring(env.HUAMEI_CONTACT_VAULT_KEYRING_JSON, {
    disallowedKeyrings:[env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON]
  });
  if (!contactVault.configured) failures.push("CONTACT_VAULT_KEYRING_REQUIRED");
  else if (!contactVault.valid) failures.push(...contactVault.errors.map((error) => error.code));

  const formalEvidencePaths = [];
  for (const spec of [...formalReportSpecs, ...formalSourceSpecs, ...formalAuxiliarySpecs]) {
    const path = String(env[spec.pathField] || "").trim();
    const label = spec.name.toUpperCase();
    if (!isAbsolute(path)) failures.push(`${label}_ABSOLUTE_PATH_REQUIRED`);
    else formalEvidencePaths.push(path);
    if (!validSha256(env[spec.digestField])) failures.push(`${label}_SHA256_REQUIRED`);
  }
  if (new Set(formalEvidencePaths).size !== formalEvidencePaths.length) {
    failures.push("FORMAL_EVIDENCE_PATHS_MUST_BE_DISTINCT");
  }
  const endpointRegistryPath = String(env.HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH || "").trim();
  if (!isAbsolute(endpointRegistryPath)) failures.push("FORMAL_EVALUATION_ENDPOINT_REGISTRY_ABSOLUTE_PATH_REQUIRED");
  else if (formalEvidencePaths.includes(endpointRegistryPath)) failures.push("FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH_MUST_BE_DISTINCT");
  if (!validSha256(env.HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_SHA256)) {
    failures.push("FORMAL_EVALUATION_ENDPOINT_REGISTRY_SHA256_REQUIRED");
  }

  if (normalizedBoolean(env.HUAMEI_OUTBOX_DELIVERY_ENABLED)) {
    let targetIsHttps = false;
    try { targetIsHttps = new URL(String(env.HUAMEI_OUTBOX_TARGET_URL || "")).protocol === "https:"; } catch {}
    if (!targetIsHttps) failures.push("OUTBOX_HTTPS_TARGET_REQUIRED");
    if (String(env.HUAMEI_OUTBOX_TARGET_SERVICE_KEY || "").trim().length < 32) {
      failures.push("OUTBOX_TARGET_SERVICE_KEY_REQUIRED");
    }
    const outboxTenants = String(env.HUAMEI_OUTBOX_TENANTS || "").split(",")
      .map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!outboxTenants.length || outboxTenants.some((tenantId) => !tenantIdPattern.test(tenantId))) {
      failures.push("OUTBOX_TENANTS_INVALID");
    }
  }
  return {
    ok:failures.length === 0,
    release_id:releaseId || null,
    tenant_ids:tenants,
    failures,
    model:{ provider:llmProvider || null, model:llmModel || null, llm_host:llmHost, graphrag_host:graphHost },
    field_encryption:{ configured:fieldEncryption.configured, valid:fieldEncryption.valid, active_key_id:fieldEncryption.active_key_id },
    contact_vault:{
      configured:contactVault.configured,
      valid:contactVault.valid,
      independent:contactVault.independent,
      active_key_id:contactVault.active_key_id
    }
  };
}

const validTimestamp = (value) => Number.isFinite(new Date(String(value || "")).getTime());
const validateCommonEvidence = (kind, report, env, failures) => {
  const reportEvidenceKind = `${kind}_report`;
  const reportVerification = verifyEvidenceDocumentAttestation(report, {
    evidenceKind:reportEvidenceKind,
    trustedSigners:trustedSignerRegistryFromEnv(env)
  });
  if (!reportVerification.ok) {
    failures.push(...reportVerification.failures.map((code) => `${kind.toUpperCase()}_${code}`));
  }
  if (report.schema_version !== evidenceSchema[kind]) failures.push(`${kind.toUpperCase()}_EVIDENCE_SCHEMA_INVALID`);
  if (report.release_id !== String(env.HUAMEI_RELEASE_ID || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_RELEASE_MISMATCH`);
  const expectedEnvironment = String(env.HUAMEI_EVIDENCE_ENVIRONMENT || env.HUAMEI_DEPLOYMENT_ENV || env.HUAMEI_RUNTIME_ENV || "").trim().toLowerCase();
  if (!["preproduction", "production"].includes(report.environment)) failures.push(`${kind.toUpperCase()}_EVIDENCE_ENVIRONMENT_INVALID`);
  if (report.environment !== expectedEnvironment) failures.push(`${kind.toUpperCase()}_EVIDENCE_ENVIRONMENT_MISMATCH`);
  if (!validTimestamp(report.generated_at)) failures.push(`${kind.toUpperCase()}_EVIDENCE_TIMESTAMP_INVALID`);
  if (report.application_image !== String(env.HUAMEI_APP_IMAGE || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_APP_IMAGE_MISMATCH`);
  if (report.graphrag_image !== String(env.HUAMEI_GRAPHRAG_IMAGE || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_GRAPHRAG_IMAGE_MISMATCH`);
  if (report.index_version !== String(env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_INDEX_VERSION_MISMATCH`);
  if (!validSha256(report.knowledge_manifest_sha256)
    || report.knowledge_manifest_sha256 !== String(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase()) {
    failures.push(`${kind.toUpperCase()}_EVIDENCE_MANIFEST_MISMATCH`);
  }
  if (report.passed !== true) failures.push(`${kind.toUpperCase()}_EVIDENCE_NOT_PASSED`);
  const activeKnowledge = objectValue(report.active_knowledge);
  if (activeKnowledge.release_id !== String(env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID || "").trim()
    || activeKnowledge.index_version !== String(env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim()
    || activeKnowledge.manifest_sha256 !== String(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase()
    || activeKnowledge.engine !== "official_graphrag_3_1_1") {
    failures.push(`${kind.toUpperCase()}_EVIDENCE_ACTIVE_KNOWLEDGE_MISMATCH`);
  }
  const llm = objectValue(report.llm);
  if (llm.enabled !== true) failures.push(`${kind.toUpperCase()}_EVIDENCE_LLM_DISABLED`);
  if (llm.provider !== String(env.HUAMEI_LLM_PROVIDER || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_LLM_PROVIDER_MISMATCH`);
  if (llm.model !== String(env.HUAMEI_LLM_MODEL || "").trim()) failures.push(`${kind.toUpperCase()}_EVIDENCE_LLM_MODEL_MISMATCH`);
  const approval = objectValue(report.approval);
  if (approval.status !== "approved" || !safeReference(approval.approval_id) || !safeReference(approval.approved_by) || !validTimestamp(approval.approved_at)) {
    failures.push(`${kind.toUpperCase()}_EVIDENCE_APPROVAL_INVALID`);
  }
  const expectedSources = kind === "evaluation"
    ? { blind_dataset:"blind_dataset", evaluation_raw:"evaluation_raw", evaluation_scorecard:"evaluation_scorecard" }
    : { capacity_raw:"capacity_raw", capacity_observability_attestation:"capacity_observability_attestation" };
  const verifiedSources = objectValue(report.verified_sources);
  const sourceSignerIds = [];
  const sourceSignerFingerprints = [];
  for (const [name, evidenceKind] of Object.entries(expectedSources)) {
    const source = objectValue(verifiedSources[name]);
    if (!safeReference(source.signer_id)
      || source.evidence_kind !== evidenceKind
      || source.authority_role !== FORMAL_EVIDENCE_AUTHORITY_BY_KIND[evidenceKind]
      || !validSha256(source.public_key_spki_sha256)
      || !validSha256(source.signed_payload_sha256)
      || !validTimestamp(source.signed_at)) {
      failures.push(`${kind.toUpperCase()}_${name.toUpperCase()}_VERIFIED_SOURCE_INVALID`);
    } else {
      sourceSignerIds.push(source.signer_id);
      sourceSignerFingerprints.push(source.public_key_spki_sha256);
    }
  }
  if (sourceSignerIds.length !== Object.keys(expectedSources).length
    || new Set(sourceSignerIds).size !== sourceSignerIds.length) {
    failures.push(`${kind.toUpperCase()}_VERIFIED_SOURCE_AUTHORITIES_NOT_INDEPENDENT`);
  }
  if (sourceSignerFingerprints.length !== Object.keys(expectedSources).length
    || new Set(sourceSignerFingerprints).size !== sourceSignerFingerprints.length) {
    failures.push(`${kind.toUpperCase()}_VERIFIED_SOURCE_SIGNING_KEYS_NOT_INDEPENDENT`);
  }
  if (reportVerification.signer && (sourceSignerIds.includes(reportVerification.signer.signer_id)
    || sourceSignerFingerprints.includes(reportVerification.signer.public_key_spki_sha256))) {
    failures.push(`${kind.toUpperCase()}_REPORT_ISSUER_NOT_INDEPENDENT`);
  }
  return {
    sourceSignerIds,
    sourceSignerFingerprints,
    reportSigner:reportVerification.signer || null
  };
};

export function validateFormalReleaseEvidence({ evaluation = {}, capacity = {}, env = process.env } = {}) {
  const failures = [];
  const evaluationSigners = validateCommonEvidence("evaluation", objectValue(evaluation), env, failures);
  const capacitySigners = validateCommonEvidence("capacity", objectValue(capacity), env, failures);
  const allSignerIds = [
    ...evaluationSigners.sourceSignerIds,
    ...capacitySigners.sourceSignerIds,
    evaluationSigners.reportSigner?.signer_id,
    capacitySigners.reportSigner?.signer_id
  ].filter(Boolean);
  const allSignerFingerprints = [
    ...evaluationSigners.sourceSignerFingerprints,
    ...capacitySigners.sourceSignerFingerprints,
    evaluationSigners.reportSigner?.public_key_spki_sha256,
    capacitySigners.reportSigner?.public_key_spki_sha256
  ].filter(Boolean);
  if (allSignerIds.length !== 7 || new Set(allSignerIds).size !== 7) {
    failures.push("FORMAL_EVIDENCE_SIGNERS_NOT_GLOBALLY_INDEPENDENT");
  }
  if (allSignerFingerprints.length !== 7 || new Set(allSignerFingerprints).size !== 7) {
    failures.push("FORMAL_EVIDENCE_SIGNING_KEYS_NOT_GLOBALLY_INDEPENDENT");
  }
  if (!validSha256(evaluation.dataset_sha256)) failures.push("EVALUATION_DATASET_SHA256_INVALID");
  if (!Number.isInteger(evaluation.case_count) || evaluation.case_count < 1) failures.push("EVALUATION_CASE_COUNT_INVALID");
  if (objectValue(evaluation.acceptance).passed !== true) failures.push("EVALUATION_ACCEPTANCE_NOT_PASSED");
  if (!Number.isInteger(capacity.concurrent_users) || capacity.concurrent_users < 20) failures.push("CAPACITY_20_CONCURRENT_USERS_NOT_PROVEN");
  if (!Number.isFinite(capacity.duration_seconds) || capacity.duration_seconds < 1800) failures.push("CAPACITY_SOAK_DURATION_NOT_PROVEN");
  if (objectValue(capacity.acceptance).passed !== true) failures.push("CAPACITY_ACCEPTANCE_NOT_PASSED");
  if (!validSha256(capacity.prometheus_export_sha256)) failures.push("CAPACITY_PROMETHEUS_EXPORT_SHA256_INVALID");
  const capacityLlm = objectValue(capacity.llm);
  if (!(Number(capacityLlm.attempt_count) > 0)
    || Number(capacityLlm.success_rate) < 0.99) failures.push("CAPACITY_LIVE_MODEL_SUCCESS_NOT_PROVEN");
  const graph = objectValue(capacity.active_knowledge);
  if (!(Number(graph.attempt_count) > 0) || Number(graph.success_rate) < 0.99
    || Number(graph.cache_miss_ratio) < 0.95) failures.push("CAPACITY_GRAPHRAG_SUCCESS_NOT_PROVEN");
  const graphModel = objectValue(capacity.graphrag_query_model);
  if (graphModel.provider !== String(env.GRAPHRAG_MODEL_PROVIDER || "").trim()
    || graphModel.model !== String(env.GRAPHRAG_COMPLETION_MODEL || "").trim()
    || Number(graphModel.attempt_coverage) < 0.95 || Number(graphModel.success_rate) < 0.99) {
    failures.push("CAPACITY_GRAPHRAG_QUERY_MODEL_NOT_PROVEN");
  }
  const formalTaxonomy = objectValue(capacity.formal_load_taxonomy);
  if (!validSha256(formalTaxonomy.manifest_sha256)
    || formalTaxonomy.manifest_sha256 !== String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256 || "").trim().toLowerCase()
    || !validSha256(formalTaxonomy.signed_payload_sha256)
    || !validSha256(formalTaxonomy.catalog_sha256)
    || !(Number(formalTaxonomy.applied) > 0)
    || Number(formalTaxonomy.rejected) !== 0
    || Number(formalTaxonomy.application_ratio) !== 1
    || Number(formalTaxonomy.distinct_entry_count) !== Number(formalTaxonomy.applied)
    || !validSha256(formalTaxonomy.entry_ids_sha256)) {
    failures.push("CAPACITY_FORMAL_LOAD_TAXONOMY_NOT_PROVEN");
  }
  const quota = objectValue(capacity.provider_quota);
  if (quota.approved !== true || !(Number(quota.requests_per_minute) > 0) || !(Number(quota.tokens_per_minute) > 0)) {
    failures.push("CAPACITY_PROVIDER_QUOTA_NOT_PROVEN");
  }
  const graphQuota = objectValue(capacity.graphrag_provider_quota);
  if (graphQuota.approved !== true
    || graphQuota.provider !== String(env.GRAPHRAG_MODEL_PROVIDER || "").trim()
    || graphQuota.model !== String(env.GRAPHRAG_COMPLETION_MODEL || "").trim()
    || !(Number(graphQuota.requests_per_minute) > 0) || !(Number(graphQuota.tokens_per_minute) > 0)) {
    failures.push("CAPACITY_GRAPHRAG_PROVIDER_QUOTA_NOT_PROVEN");
  }
  return {
    ok:failures.length === 0,
    failures,
    evidence:{
      evaluation_schema:evaluation.schema_version || null,
      capacity_schema:capacity.schema_version || null,
      index_version:evaluation.index_version || null,
      knowledge_manifest_sha256:evaluation.knowledge_manifest_sha256 || null,
      knowledge_release_id:objectValue(evaluation.active_knowledge).release_id || null,
      concurrent_users:Number.isInteger(capacity.concurrent_users) ? capacity.concurrent_users : null,
      duration_seconds:Number.isFinite(capacity.duration_seconds) ? capacity.duration_seconds : null
    }
  };
}

const signerSummaryFields = [
  "signer_id", "evidence_kind", "authority_role", "public_key_spki_sha256", "signed_payload_sha256", "signed_at"
];
const sourceBindingFields = (env, environment, tenantId) => ({
  release_id:String(env.HUAMEI_RELEASE_ID || "").trim(),
  knowledge_release_id:String(env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID || "").trim(),
  environment,
  tenant_id:tenantId,
  application_image:String(env.HUAMEI_APP_IMAGE || "").trim(),
  graphrag_image:String(env.HUAMEI_GRAPHRAG_IMAGE || "").trim(),
  index_version:String(env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim(),
  knowledge_manifest_sha256:String(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase()
});
const capacitySourceBindingFields = (env, environment, tenantId) => ({
  ...sourceBindingFields(env, environment, tenantId),
  llm_provider:String(env.HUAMEI_LLM_PROVIDER || "").trim(),
  llm_model:String(env.HUAMEI_LLM_MODEL || "").trim(),
  graphrag_model_provider:String(env.GRAPHRAG_MODEL_PROVIDER || "").trim(),
  graphrag_model:String(env.GRAPHRAG_COMPLETION_MODEL || "").trim()
});

export function validateFormalSourceEvidence({
  evaluation = {},
  capacity = {},
  sources = {},
  sourceDigests = {},
  evaluationTarget = {},
  env = process.env
} = {}) {
  const failures = [];
  const registry = trustedSignerRegistryFromEnv(env);
  const reports = { evaluation:objectValue(evaluation), capacity:objectValue(capacity) };
  const actualSummaries = {};
  const actualSignerIds = [];
  const actualSignerFingerprints = [];

  for (const spec of formalSourceSpecs) {
    const document = objectValue(sources[spec.name]);
    const prefix = spec.name.toUpperCase();
    if (document.schema_version !== spec.schema) failures.push(`${prefix}_SCHEMA_INVALID`);
    const verification = verifyEvidenceDocumentAttestation(document, {
      evidenceKind:spec.evidenceKind,
      trustedSigners:registry
    });
    if (!verification.ok || !verification.signer) {
      failures.push(...verification.failures.map((code) => `${prefix}_${code}`));
      continue;
    }
    actualSummaries[spec.name] = verification.signer;
    actualSignerIds.push(verification.signer.signer_id);
    actualSignerFingerprints.push(verification.signer.public_key_spki_sha256);
    const reportedSummary = objectValue(reports[spec.report].verified_sources?.[spec.name]);
    for (const field of signerSummaryFields) {
      if (reportedSummary[field] !== verification.signer[field]) {
        failures.push(`${prefix}_FINAL_REPORT_SUMMARY_${field.toUpperCase()}_MISMATCH`);
      }
    }
  }

  const reportSignerIds = [];
  const reportSignerFingerprints = [];
  for (const [reportName, evidenceKind] of [["evaluation", "evaluation_report"], ["capacity", "capacity_report"]]) {
    const verification = verifyEvidenceDocumentAttestation(reports[reportName], { evidenceKind, trustedSigners:registry });
    if (verification.ok && verification.signer) {
      reportSignerIds.push(verification.signer.signer_id);
      reportSignerFingerprints.push(verification.signer.public_key_spki_sha256);
    }
  }
  const allSignerIds = [...actualSignerIds, ...reportSignerIds];
  if (allSignerIds.length !== formalSourceSpecs.length + formalReportSpecs.length
    || new Set(allSignerIds).size !== allSignerIds.length) {
    failures.push("FORMAL_EVIDENCE_SIGNERS_NOT_GLOBALLY_INDEPENDENT");
  }
  const allSignerFingerprints = [...actualSignerFingerprints, ...reportSignerFingerprints];
  if (allSignerFingerprints.length !== formalSourceSpecs.length + formalReportSpecs.length
    || new Set(allSignerFingerprints).size !== allSignerFingerprints.length) {
    failures.push("FORMAL_EVIDENCE_SIGNING_KEYS_NOT_GLOBALLY_INDEPENDENT");
  }

  if (evaluation.environment !== capacity.environment) failures.push("FORMAL_EVIDENCE_ENVIRONMENT_MISMATCH");
  const releaseTenants = parseReleaseTenants(env);
  const tenantId = releaseTenants.length === 1 ? releaseTenants[0] : "";
  const evaluationBinding = sourceBindingFields(env, evaluation.environment, tenantId);
  const capacityBinding = capacitySourceBindingFields(env, capacity.environment, tenantId);
  const strictEvaluationBinding = productionEvaluationBindingFromEnv({
    ...env,
    HUAMEI_RELEASE_TENANT_ID:tenantId
  });
  const trustedTargetValidation = validateFormalEvaluationEndpointTarget(evaluationTarget, strictEvaluationBinding);
  failures.push(...trustedTargetValidation.failures.map((code) => `PREFLIGHT_TRUSTED_${code}`));
  const assertFields = (name, document, expected, fields) => {
    for (const field of fields) {
      if (document[field] !== expected[field]) failures.push(`${name.toUpperCase()}_${field.toUpperCase()}_BINDING_MISMATCH`);
    }
  };

  const blindDataset = objectValue(sources.blind_dataset);
  const evaluationRaw = objectValue(sources.evaluation_raw);
  const scorecard = objectValue(sources.evaluation_scorecard);
  const capacityRaw = objectValue(sources.capacity_raw);
  const capacityPrometheus = objectValue(sources.capacity_prometheus);
  const capacityAttestation = objectValue(sources.capacity_observability_attestation);

  const rawTargetValidation = validateFormalEvaluationEndpointTarget(
    evaluationRaw.evaluation_target,
    strictEvaluationBinding,
    trustedTargetValidation.target
  );
  failures.push(...rawTargetValidation.failures.map((code) => `PREFLIGHT_RAW_${code}`));
  const finalTargetValidation = validateFormalEvaluationEndpointTarget(
    evaluation.evaluation_target,
    strictEvaluationBinding,
    trustedTargetValidation.target
  );
  failures.push(...finalTargetValidation.failures.map((code) => `PREFLIGHT_FINAL_${code}`));
  if (canonicalJson(rawTargetValidation.target) !== canonicalJson(finalTargetValidation.target)) {
    failures.push("EVALUATION_TARGET_RAW_FINAL_MISMATCH");
  }

  if (evaluation.dataset_sha256 !== sourceDigests.blind_dataset) failures.push("EVALUATION_DATASET_FILE_SHA256_MISMATCH");
  if (evaluation.dataset_id !== blindDataset.dataset_id) failures.push("EVALUATION_DATASET_ID_SOURCE_MISMATCH");
  if (evaluation.raw_report_sha256 !== sourceDigests.evaluation_raw) failures.push("EVALUATION_RAW_FILE_SHA256_MISMATCH");
  if (evaluation.scorecard_sha256 !== sourceDigests.evaluation_scorecard) failures.push("EVALUATION_SCORECARD_FILE_SHA256_MISMATCH");
  if (evaluationRaw.dataset_sha256 !== sourceDigests.blind_dataset) failures.push("EVALUATION_RAW_DATASET_SHA256_MISMATCH");
  if (evaluationRaw.dataset_id !== blindDataset.dataset_id) failures.push("EVALUATION_RAW_DATASET_ID_MISMATCH");
  assertFields("evaluation_raw", evaluationRaw, evaluationBinding, Object.keys(evaluationBinding));
  if (evaluationRaw.llm?.enabled !== true
    || evaluationRaw.llm?.provider !== String(env.HUAMEI_LLM_PROVIDER || "").trim()
    || evaluationRaw.llm?.model !== String(env.HUAMEI_LLM_MODEL || "").trim()) {
    failures.push("EVALUATION_RAW_LLM_BINDING_MISMATCH");
  }

  if (scorecard.dataset_sha256 !== sourceDigests.blind_dataset) failures.push("EVALUATION_SCORECARD_DATASET_SHA256_MISMATCH");
  if (scorecard.raw_report_sha256 !== sourceDigests.evaluation_raw) failures.push("EVALUATION_SCORECARD_RAW_SHA256_MISMATCH");
  assertFields("evaluation_scorecard", scorecard, evaluationBinding, [
    "release_id", "knowledge_release_id", "index_version", "knowledge_manifest_sha256"
  ]);

  if (capacity.raw_report_sha256 !== sourceDigests.capacity_raw) failures.push("CAPACITY_RAW_FILE_SHA256_MISMATCH");
  if (capacity.raw_report_path !== String(env.HUAMEI_FORMAL_CAPACITY_RAW_PATH || "").trim()) {
    failures.push("CAPACITY_RAW_FILE_PATH_MISMATCH");
  }
  if (capacity.prometheus_export_sha256 !== sourceDigests.capacity_prometheus) {
    failures.push("CAPACITY_PROMETHEUS_FILE_SHA256_MISMATCH");
  }
  if (capacity.prometheus_export_path !== String(env.HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH || "").trim()) {
    failures.push("CAPACITY_PROMETHEUS_FILE_PATH_MISMATCH");
  }
  if (capacity.attestation_sha256 !== sourceDigests.capacity_observability_attestation) {
    failures.push("CAPACITY_ATTESTATION_FILE_SHA256_MISMATCH");
  }
  if (capacityRaw.tenant_id !== tenantId) failures.push("CAPACITY_RAW_TENANT_ID_BINDING_MISMATCH");
  if (capacityAttestation.raw_report_sha256 !== sourceDigests.capacity_raw) failures.push("CAPACITY_ATTESTATION_RAW_SHA256_MISMATCH");
  if (capacityAttestation.prometheus_export_sha256 !== sourceDigests.capacity_prometheus) {
    failures.push("CAPACITY_ATTESTATION_PROMETHEUS_SHA256_MISMATCH");
  }
  assertFields("capacity_observability_attestation", capacityAttestation, capacityBinding, Object.keys(capacityBinding));
  const telemetryModel = objectValue(objectValue(capacityAttestation.telemetry).live_model);
  if (telemetryModel.provider !== String(env.HUAMEI_LLM_PROVIDER || "").trim()
    || telemetryModel.model !== String(env.HUAMEI_LLM_MODEL || "").trim()) {
    failures.push("CAPACITY_ATTESTATION_LLM_BINDING_MISMATCH");
  }

  const strictBinding = productionCapacityBindingFromEnv({
    ...env,
    HUAMEI_EVIDENCE_ENVIRONMENT:capacity.environment,
    HUAMEI_RELEASE_TENANT_ID:tenantId
  });
  const rawValidation = validateRawCapacityReport(capacityRaw, {
    tenantId,
    binding:strictBinding
  });
  failures.push(...rawValidation.failures.map((code) => `PREFLIGHT_${code}`));
  const prometheusValidation = validatePrometheusCapacityExport(capacityPrometheus, {
    binding:strictBinding,
    rawReport:capacityRaw,
    rawValidation
  });
  failures.push(...prometheusValidation.failures.map((code) => `PREFLIGHT_${code}`));
  const attestationValidation = validateCapacityAttestation(capacityAttestation, {
    binding:strictBinding,
    rawReport:capacityRaw,
    rawReportSha256:sourceDigests.capacity_raw,
    rawValidation,
    prometheusExport:capacityPrometheus,
    prometheusExportSha256:sourceDigests.capacity_prometheus,
    prometheusValidation
  });
  failures.push(...attestationValidation.failures.map((code) => `PREFLIGHT_${code}`));

  const rawMetrics = rawValidation.metrics || {};
  const telemetry = attestationValidation.telemetry || {};
  const exact = (value, expected) => Number(value) === Number(expected);
  if (capacity.concurrent_users !== rawMetrics.concurrent_users
    || !exact(capacity.duration_seconds, rawMetrics.steady_state_duration_seconds)
    || !exact(capacity.metrics?.raw?.requests, rawMetrics.requests)
    || !exact(capacity.metrics?.raw?.success, rawMetrics.success)
    || !exact(capacity.metrics?.raw?.error_rate, rawMetrics.error_rate)
    || !exact(capacity.metrics?.raw?.latency_ms?.p95, rawMetrics.latency_ms?.p95)) {
    failures.push("CAPACITY_FINAL_RAW_METRICS_MISMATCH");
  }
  if (!exact(capacity.llm?.attempt_count, telemetry.live_model?.attempts)
    || !exact(capacity.llm?.success_count, telemetry.live_model?.success)
    || !exact(capacity.llm?.success_rate, telemetry.live_model?.success_rate)) {
    failures.push("CAPACITY_FINAL_LIVE_MODEL_METRICS_MISMATCH");
  }
  if (!exact(capacity.active_knowledge?.attempt_count, telemetry.graphrag?.attempts)
    || !exact(capacity.active_knowledge?.success_count, telemetry.graphrag?.success)
    || !exact(capacity.active_knowledge?.cache_miss_count, telemetry.graphrag?.cache_misses)
    || !exact(capacity.active_knowledge?.cache_miss_ratio, telemetry.graphrag?.cache_miss_ratio)) {
    failures.push("CAPACITY_FINAL_GRAPHRAG_METRICS_MISMATCH");
  }
  if (!exact(capacity.graphrag_query_model?.attempt_count, telemetry.graphrag_query_model?.attempts)
    || !exact(capacity.graphrag_query_model?.success_count, telemetry.graphrag_query_model?.success)
    || !exact(capacity.graphrag_query_model?.attempt_coverage, telemetry.graphrag_query_model?.attempt_coverage)
    || !exact(capacity.graphrag_query_model?.success_rate, telemetry.graphrag_query_model?.success_rate)) {
    failures.push("CAPACITY_FINAL_GRAPHRAG_MODEL_METRICS_MISMATCH");
  }
  if (canonicalJson(capacity.formal_load_taxonomy) !== canonicalJson({
    manifest_id:telemetry.formal_load_taxonomy?.manifest_id || null,
    manifest_sha256:telemetry.formal_load_taxonomy?.manifest_sha256 || null,
    signer_id:telemetry.formal_load_taxonomy?.signer_id || null,
    signed_payload_sha256:telemetry.formal_load_taxonomy?.signed_payload_sha256 || null,
    catalog_sha256:telemetry.formal_load_taxonomy?.catalog_sha256 || null,
    algorithm_version:telemetry.formal_load_taxonomy?.algorithm_version || null,
    applied:telemetry.formal_load_taxonomy?.applied || 0,
    rejected:telemetry.formal_load_taxonomy?.rejected || 0,
    application_ratio:telemetry.formal_load_taxonomy?.application_ratio || 0,
    distinct_entry_count:rawMetrics.formal_load_taxonomy?.distinct_entry_count || 0,
    entry_ids_sha256:rawMetrics.formal_load_taxonomy?.entry_ids_sha256 || null
  })) failures.push("CAPACITY_FINAL_FORMAL_LOAD_TAXONOMY_MISMATCH");
  const expectedRawSummary = {
    requested_duration_seconds:rawMetrics.requested_duration_seconds,
    actual_duration_seconds:rawMetrics.actual_duration_seconds,
    ramp_seconds:rawMetrics.ramp_seconds,
    steady_state_duration_seconds:rawMetrics.steady_state_duration_seconds,
    requests:rawMetrics.requests,
    success:rawMetrics.success,
    error_rate:rawMetrics.error_rate,
    throughput_rps:rawMetrics.throughput_rps,
    latency_ms:rawMetrics.latency_ms,
    latency_sample_count:rawMetrics.latency_sample_count,
    turn_latency_p95_ms:rawMetrics.turn_latency_p95_ms,
    minute_buckets:rawMetrics.minute_buckets,
    status_counts:rawMetrics.status_counts,
    query_diversity:rawMetrics.query_diversity,
    formal_load_taxonomy:rawMetrics.formal_load_taxonomy,
    load_identity:rawMetrics.load_identity
  };
  if (canonicalJson(capacity.metrics?.raw) !== canonicalJson(expectedRawSummary)) {
    failures.push("CAPACITY_FINAL_RAW_SUMMARY_MISMATCH");
  }
  if (canonicalJson(capacity.metrics?.telemetry) !== canonicalJson(telemetry)) {
    failures.push("CAPACITY_FINAL_TELEMETRY_SUMMARY_MISMATCH");
  }
  const quotaFields = [
    "approved", "provider", "model", "requests_per_minute", "tokens_per_minute",
    "approval_id", "approved_by", "approved_at", "valid_from", "valid_until"
  ];
  const quotaSummary = (value) => Object.fromEntries(quotaFields.map((field) => [field, objectValue(value)[field]]));
  if (canonicalJson(quotaSummary(capacity.provider_quota))
    !== canonicalJson(quotaSummary(attestationValidation.providerQuota))) {
    failures.push("CAPACITY_FINAL_PROVIDER_QUOTA_MISMATCH");
  }
  if (canonicalJson(quotaSummary(capacity.graphrag_provider_quota))
    !== canonicalJson(quotaSummary(attestationValidation.graphRagProviderQuota))) {
    failures.push("CAPACITY_FINAL_GRAPHRAG_PROVIDER_QUOTA_MISMATCH");
  }

  return { ok:failures.length === 0, failures, signers:actualSummaries };
}

export async function loadFormalReleaseEvidence(env = process.env, options = {}) {
  const read = options.readFileImpl || readFile;
  const failures = [];
  const reports = {};
  const sources = {};
  const digests = {};
  let evaluationTarget = {};
  const specs = [
    ...formalReportSpecs.map((spec) => ({ ...spec, target:reports, maximumBytes:20 * 1024 * 1024 })),
    ...formalSourceSpecs.map((spec) => ({ ...spec, target:sources, maximumBytes:20 * 1024 * 1024 })),
    ...formalAuxiliarySpecs.map((spec) => ({ ...spec, target:sources, maximumBytes:100 * 1024 * 1024 }))
  ];
  for (const spec of specs) {
    const path = String(env[spec.pathField] || "").trim();
    const label = spec.name.toUpperCase();
    if (!isAbsolute(path)) {
      failures.push(`${label}_PATH_INVALID`);
      continue;
    }
    try {
      const content = await read(path);
      if (!content?.length || content.length > spec.maximumBytes) {
        failures.push(`${label}_FILE_SIZE_INVALID`);
        continue;
      }
      const actual = sha256(content);
      digests[spec.name] = actual;
      if (actual !== String(env[spec.digestField] || "").trim().toLowerCase()) {
        failures.push(`${label}_CHECKSUM_MISMATCH`);
        continue;
      }
      try { spec.target[spec.name] = JSON.parse(content.toString("utf8")); }
      catch { failures.push(`${label}_JSON_INVALID`); }
    } catch {
      failures.push(`${label}_UNREADABLE`);
    }
  }
  if (!failures.length) {
    try {
      const tenantIds = parseReleaseTenants(env);
      const binding = productionEvaluationBindingFromEnv({
        ...env,
        HUAMEI_RELEASE_TENANT_ID:tenantIds.length === 1 ? tenantIds[0] : ""
      });
      evaluationTarget = await loadFormalEvaluationEndpointTarget({
        env,
        binding,
        assertedOrigin:env.HUAMEI_FORMAL_EVALUATION_EXPECTED_ORIGIN,
        readFileImpl:read
      });
    } catch (error) {
      failures.push(safeCode(error, "FORMAL_EVALUATION_ENDPOINT_REGISTRY_INVALID"));
    }
  }
  if (!failures.length) {
    failures.push(...validateFormalReleaseEvidence({ ...reports, env }).failures);
    failures.push(...validateFormalSourceEvidence({
      ...reports,
      sources,
      sourceDigests:digests,
      evaluationTarget,
      env
    }).failures);
  }
  return {
    ok:failures.length === 0,
    failures,
    evaluation_target:Object.keys(evaluationTarget).length ? evaluationTarget : null,
    sha256:Object.fromEntries(specs.map((spec) => [spec.name, digests[spec.name] || null]))
  };
}

const normalizedPrivileges = (value) => new Set(Array.isArray(value)
  ? value.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean)
  : []);
const samePrivileges = (left, right) => left.size === right.size && [...left].every((item) => right.has(item));

export function validateRuntimeObjectAclEvidence({
  relationAclRows = [],
  sequenceAclRows = [],
  functionAclRows = []
} = {}) {
  const failures = [];
  const expectedTablePrivileges = postgresRuntimeTablePrivilegeMap();
  const observedRelations = new Set(relationAclRows.map((row) => String(row.relname || "")));
  for (const table of expectedTablePrivileges.keys()) {
    if (!observedRelations.has(table)) failures.push(`RUNTIME_TABLE_ACL_EVIDENCE_MISSING:${table}`);
  }
  for (const row of relationAclRows) {
    const table = String(row.relname || "");
    const runtime = normalizedPrivileges(row.runtime_privileges);
    const migrator = normalizedPrivileges(row.migrator_privileges);
    const publicPrivileges = normalizedPrivileges(row.public_privileges);
    const expected = expectedTablePrivileges.get(table) || new Set();
    if (!samePrivileges(runtime, expected)) failures.push(`RUNTIME_TABLE_ACL_MISMATCH:${table}`);
    if (migrator.size) failures.push(`MIGRATOR_TABLE_ACL_FORBIDDEN:${table}`);
    if (publicPrivileges.size) failures.push(`PUBLIC_TABLE_ACL_FORBIDDEN:${table}`);
  }
  for (const row of sequenceAclRows) {
    const sequence = String(row.relname || "");
    if (!samePrivileges(normalizedPrivileges(row.runtime_privileges), new Set(["SELECT", "USAGE"]))) {
      failures.push(`RUNTIME_SEQUENCE_ACL_MISMATCH:${sequence}`);
    }
    if (normalizedPrivileges(row.migrator_privileges).size) failures.push(`MIGRATOR_SEQUENCE_ACL_FORBIDDEN:${sequence}`);
    if (normalizedPrivileges(row.public_privileges).size) failures.push(`PUBLIC_SEQUENCE_ACL_FORBIDDEN:${sequence}`);
  }
  let approvedSecurityDefiners = 0;
  let runtimeCallableFunctions = 0;
  for (const row of functionAclRows) {
    const identity = String(row.identity || "unknown");
    if (row.approved_security_definer === true) approvedSecurityDefiners += 1;
    if (row.runtime_callable === true) runtimeCallableFunctions += 1;
    if ((row.security_definer === true) !== (row.approved_security_definer === true)) {
      failures.push(`SECURITY_DEFINER_NOT_APPROVED:${identity}`);
    }
    if ((row.runtime_execute === true) !== (row.runtime_callable === true)) {
      failures.push(`RUNTIME_FUNCTION_ACL_MISMATCH:${identity}`);
    }
    if (row.migrator_execute === true) failures.push(`MIGRATOR_FUNCTION_EXECUTE_FORBIDDEN:${identity}`);
    if (row.public_execute === true) failures.push(`PUBLIC_FUNCTION_EXECUTE_FORBIDDEN:${identity}`);
  }
  if (approvedSecurityDefiners !== POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS.length) {
    failures.push("APPROVED_SECURITY_DEFINER_SET_INCOMPLETE");
  }
  if (runtimeCallableFunctions !== POSTGRES_RUNTIME_CALLABLE_FUNCTIONS.length) {
    failures.push("RUNTIME_CALLABLE_FUNCTION_SET_INCOMPLETE");
  }
  return {
    ok:failures.length === 0,
    failures,
    relation_count:relationAclRows.length,
    sequence_count:sequenceAclRows.length,
    function_count:functionAclRows.length
  };
}

export async function loadRuntimeObjectAclEvidence(database) {
  if (!database || typeof database.query !== "function") {
    const error = new Error("Runtime database query adapter is required for object ACL evidence");
    error.code = "RUNTIME_OBJECT_ACL_DATABASE_REQUIRED";
    throw error;
  }
  const [relationAclResult, sequenceAclResult, functionAclResult] = await Promise.all([
    database.query(
      `SELECT object.relname,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('r',object.relowner))) acl
               WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_runtime')
               ORDER BY acl.privilege_type) AS runtime_privileges,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('r',object.relowner))) acl
               WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_migrator')
               ORDER BY acl.privilege_type) AS migrator_privileges,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('r',object.relowner))) acl
               WHERE acl.grantee=0 ORDER BY acl.privilege_type) AS public_privileges
       FROM pg_class object
       JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
       WHERE namespace.nspname='public' AND object.relkind IN ('r','p','v','m','f')
       ORDER BY object.relname`
    ),
    database.query(
      `SELECT object.relname,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('S',object.relowner))) acl
               WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_runtime')
               ORDER BY acl.privilege_type) AS runtime_privileges,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('S',object.relowner))) acl
               WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_migrator')
               ORDER BY acl.privilege_type) AS migrator_privileges,
         ARRAY(SELECT acl.privilege_type::text
               FROM aclexplode(coalesce(object.relacl,acldefault('S',object.relowner))) acl
               WHERE acl.grantee=0 ORDER BY acl.privilege_type) AS public_privileges
       FROM pg_class object
       JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
       WHERE namespace.nspname='public' AND object.relkind='S'
       ORDER BY object.relname`
    ),
    database.query(
      `SELECT format('%I.%I(%s)',namespace.nspname,routine.proname,
                     pg_catalog.oidvectortypes(routine.proargtypes)) AS identity,
         routine.prosecdef AS security_definer,
         EXISTS (SELECT 1 FROM unnest($1::text[]) approved(signature)
                 WHERE to_regprocedure(approved.signature)=routine.oid) AS approved_security_definer,
         EXISTS (SELECT 1 FROM unnest($2::text[]) callable(signature)
                 WHERE to_regprocedure(callable.signature)=routine.oid) AS runtime_callable,
         EXISTS (SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
                 WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_runtime')
                   AND acl.privilege_type='EXECUTE') AS runtime_execute,
         EXISTS (SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
                 WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='huamei_migrator')
                   AND acl.privilege_type='EXECUTE') AS migrator_execute,
         EXISTS (SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
                 WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       WHERE namespace.nspname='public'
         AND (routine.prosecdef OR routine.proname LIKE 'huamei\\_%' ESCAPE '\\')
       ORDER BY identity`,
      [POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS, POSTGRES_RUNTIME_CALLABLE_FUNCTIONS]
    )
  ]);
  return {
    relationAclRows:relationAclResult.rows,
    sequenceAclRows:sequenceAclResult.rows,
    functionAclRows:functionAclResult.rows
  };
}

export function validateRuntimeSecurityEvidence({
  identity,
  rlsRows = [],
  privilegeEvidence = {},
  ownerRows = [],
  relationAclRows = [],
  sequenceAclRows = [],
  functionAclRows = []
}) {
  const failures = [];
  if (identity?.current_user !== "huamei_runtime" || identity?.session_user !== "huamei_runtime") {
    failures.push("RUNTIME_ROLE_REQUIRED");
  }
  for (const field of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls", "rolinherit"]) {
    if (identity?.[field] !== false) failures.push(`RUNTIME_${field.toUpperCase()}_FORBIDDEN`);
  }
  if (identity?.rolcanlogin !== true) failures.push("RUNTIME_LOGIN_REQUIRED");
  const rlsMap = new Map(rlsRows.map((row) => [row.relname, row]));
  for (const table of tenantTables) {
    const row = rlsMap.get(table);
    if (!row?.relrowsecurity || !row?.relforcerowsecurity) failures.push(`FORCE_RLS_MISSING:${table}`);
  }
  for (const [field, value] of Object.entries(privilegeEvidence)) {
    if (value === true) failures.push(`RUNTIME_PRIVILEGE_FORBIDDEN:${field}`);
  }
  const runtimeOwned = ownerRows.filter((row) => row.owner === "huamei_runtime").map((row) => row.relname);
  if (runtimeOwned.length) failures.push(...runtimeOwned.map((table) => `RUNTIME_TABLE_OWNERSHIP_FORBIDDEN:${table}`));
  const objectAcl = validateRuntimeObjectAclEvidence({ relationAclRows, sequenceAclRows, functionAclRows });
  failures.push(...objectAcl.failures);
  return {
    ok:failures.length === 0,
    failures,
    forced_rls_count:rlsRows.filter((row) => row.relrowsecurity && row.relforcerowsecurity).length,
    object_acl:objectAcl
  };
}

export function validateDatabaseRoleTopology({ roleRows = [], membershipRows = [] } = {}) {
  const failures = [];
  const roles = new Map(roleRows.map((row) => [String(row.rolname || ""), row]));
  const expected = {
    huamei_owner:{
      rolcanlogin:false,
      rolsuper:false,
      rolcreaterole:false,
      rolcreatedb:false,
      rolinherit:false,
      rolreplication:false,
      rolbypassrls:true
    },
    huamei_migrator:{
      rolcanlogin:true,
      rolsuper:false,
      rolcreaterole:false,
      rolcreatedb:false,
      rolinherit:false,
      rolreplication:false,
      rolbypassrls:false
    },
    huamei_runtime:{
      rolcanlogin:true,
      rolsuper:false,
      rolcreaterole:false,
      rolcreatedb:false,
      rolinherit:false,
      rolreplication:false,
      rolbypassrls:false
    }
  };
  for (const [name, attributes] of Object.entries(expected)) {
    const role = roles.get(name);
    if (!role) {
      failures.push(`DATABASE_ROLE_MISSING:${name}`);
      continue;
    }
    for (const [field, value] of Object.entries(attributes)) {
      if (role[field] !== value) failures.push(`DATABASE_ROLE_ATTRIBUTE_INVALID:${name}:${field}`);
    }
  }
  if (roles.size !== Object.keys(expected).length) failures.push("DATABASE_ROLE_INVENTORY_INVALID");
  const memberships = membershipRows.map((row) => `${String(row.role_name || "")}<-${String(row.member_name || "")}`);
  const allowed = "huamei_owner<-huamei_migrator";
  if (memberships.length !== 1 || memberships[0] !== allowed) failures.push("DATABASE_ROLE_MEMBERSHIP_TOPOLOGY_INVALID");
  if (membershipRows.length === 1 && (membershipRows[0].admin_option !== false
    || membershipRows[0].inherit_option !== false || membershipRows[0].set_option !== true)) {
    failures.push("DATABASE_ROLE_MEMBERSHIP_OPTIONS_INVALID");
  }
  return {
    ok:failures.length === 0,
    failures,
    role_count:roles.size,
    membership_edges:memberships
  };
}

const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function validateActiveKnowledgeRelease(tenantId, releaseRows = [], reviewRows = [], now = new Date()) {
  const failures = [];
  if (releaseRows.length !== 1) {
    return { ok:false, failures:[`ACTIVE_RELEASE_COUNT:${releaseRows.length}`], binding:null };
  }
  const release = releaseRows[0];
  const manifest = objectValue(release.manifest);
  const binding = objectValue(manifest.release_binding);
  const activeAt = release.effective_at ? new Date(release.effective_at).getTime() : Number.NaN;
  const expiresAt = release.expires_at ? new Date(release.expires_at).getTime() : null;
  if (release.status !== "active" || release.is_active !== true) failures.push("ACTIVE_RELEASE_STATE_INVALID");
  if (!Number.isFinite(activeAt) || activeAt > now.getTime()) failures.push("ACTIVE_RELEASE_NOT_EFFECTIVE");
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())) failures.push("ACTIVE_RELEASE_EXPIRED");
  for (const [field, value] of [
    ["package_checksum", release.package_checksum],
    ["record_list_checksum", release.record_list_checksum],
    ["index_checksum", release.index_checksum],
    ["manifest_sha256", manifest.manifest_sha256],
    ["approval_receipt_sha256", binding.approval_receipt_sha256]
  ]) if (!validSha256(value)) failures.push(`ACTIVE_RELEASE_${field.toUpperCase()}_INVALID`);
  if (!release.index_version || manifest.index_version !== release.index_version) failures.push("ACTIVE_RELEASE_INDEX_VERSION_MISMATCH");
  if (manifest.schema_version !== "huamei.graphrag.index-manifest.v1") failures.push("ACTIVE_RELEASE_MANIFEST_SCHEMA_INVALID");
  if (manifest.manifest_sha256 !== release.index_checksum) failures.push("ACTIVE_RELEASE_MANIFEST_CHECKSUM_MISMATCH");
  if (binding.tenant_id !== tenantId) failures.push("ACTIVE_RELEASE_TENANT_BINDING_MISMATCH");
  if (binding.release_id !== release.release_id) failures.push("ACTIVE_RELEASE_ID_BINDING_MISMATCH");
  if (binding.index_version !== release.index_version) failures.push("ACTIVE_RELEASE_INDEX_BINDING_MISMATCH");
  if (binding.knowledge_package_sha256 !== release.package_checksum) failures.push("ACTIVE_RELEASE_PACKAGE_BINDING_MISMATCH");
  if (binding.approved_record_list_sha256 !== release.record_list_checksum) failures.push("ACTIVE_RELEASE_RECORD_LIST_BINDING_MISMATCH");

  const expectedScopeChecksum = sha256([
    tenantId,
    release.release_id,
    release.package_version,
    release.package_checksum,
    release.record_list_checksum,
    release.index_version
  ].join("\n"));
  const byType = new Map(reviewRows.map((row) => [row.review_type, row]));
  const reviewerIds = new Set();
  for (const type of reviewTypes) {
    const row = byType.get(type);
    const approval = objectValue(objectValue(binding.approvals)[type]);
    if (!row || row.decision !== "approved") failures.push(`ACTIVE_RELEASE_${type.toUpperCase()}_REVIEW_MISSING`);
    else {
      reviewerIds.add(row.reviewer_id);
      if (objectValue(row.evidence).scope_checksum !== expectedScopeChecksum) {
        failures.push(`ACTIVE_RELEASE_${type.toUpperCase()}_SCOPE_MISMATCH`);
      }
      if (String(approval.review_id || "") !== String(row.id || "")) {
        failures.push(`ACTIVE_RELEASE_${type.toUpperCase()}_RECEIPT_MISMATCH`);
      }
    }
    if (approval.status !== "approved") failures.push(`ACTIVE_RELEASE_${type.toUpperCase()}_MANIFEST_APPROVAL_INVALID`);
  }
  if (reviewerIds.size !== 3) failures.push("ACTIVE_RELEASE_REVIEWERS_NOT_DISTINCT");
  return {
    ok:failures.length === 0,
    failures,
    binding:{
      tenant_id:tenantId,
      release_id:release.release_id,
      package_version:release.package_version,
      index_version:release.index_version,
      manifest_sha256:manifest.manifest_sha256
    }
  };
}

export function validateGraphRagReadyBinding(binding, ready = {}) {
  const failures = [];
  if (ready.ready !== true) failures.push("GRAPHRAG_NOT_READY");
  if (ready.engine !== "official_graphrag_3_1_1") failures.push("GRAPHRAG_OFFICIAL_ENGINE_REQUIRED");
  if (ready.tenant_id !== binding?.tenant_id) failures.push("GRAPHRAG_TENANT_BINDING_MISMATCH");
  if (ready.release_id !== binding?.release_id) failures.push("GRAPHRAG_RELEASE_BINDING_MISMATCH");
  if (ready.index_version !== binding?.index_version) failures.push("GRAPHRAG_INDEX_VERSION_MISMATCH");
  if (ready.manifest_sha256 !== binding?.manifest_sha256) failures.push("GRAPHRAG_MANIFEST_CHECKSUM_MISMATCH");
  return { ok:failures.length === 0, failures };
}

export function validateApplicationReadyBinding(serviceName, ready = {}, env = process.env) {
  const failures = [];
  if (ready.status !== "ready") failures.push(`${serviceName.toUpperCase()}_STATUS_NOT_READY`);
  const llm = serviceName === "app" ? objectValue(objectValue(ready.checks).llm) : objectValue(ready.llm);
  if (llm.enabled !== true || llm.configured !== true || llm.mode !== "hybrid_llm_runtime") {
    failures.push(`${serviceName.toUpperCase()}_REAL_LLM_NOT_READY`);
  }
  if (llm.provider !== String(env.HUAMEI_LLM_PROVIDER || "").trim()) failures.push(`${serviceName.toUpperCase()}_LLM_PROVIDER_MISMATCH`);
  if (llm.model !== String(env.HUAMEI_LLM_MODEL || "").trim()) failures.push(`${serviceName.toUpperCase()}_LLM_MODEL_MISMATCH`);
  const infrastructure = serviceName === "app" ? objectValue(objectValue(ready.checks).infrastructure) : objectValue(ready.infrastructure);
  const encryptionReady = objectValue(objectValue(infrastructure.configuration).backends).field_encryption_configured;
  if (encryptionReady !== true) failures.push(`${serviceName.toUpperCase()}_FIELD_ENCRYPTION_NOT_READY`);
  const contactVaultConfigured = objectValue(objectValue(infrastructure.configuration).backends)
    .contact_vault_encryption_configured;
  if (contactVaultConfigured !== true) failures.push(`${serviceName.toUpperCase()}_CONTACT_VAULT_ENCRYPTION_NOT_READY`);
  const contactVaultReady = objectValue(objectValue(infrastructure.dependencies).contact_vault).ok;
  if (contactVaultReady !== true) failures.push(`${serviceName.toUpperCase()}_CONTACT_VAULT_STORAGE_NOT_READY`);
  return { ok:failures.length === 0, failures };
}

const fetchReady = async ({ name, url, headers = {}, fetchImpl, timeoutMs }) => {
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      headers:{ Accept:"application/json", ...headers },
      signal:AbortSignal.timeout(timeoutMs)
    });
    let body = {};
    try { body = await response.json(); } catch {}
    return {
      name,
      ok:response.ok,
      http_status:response.status,
      latency_ms:Number((performance.now() - started).toFixed(1)),
      body:objectValue(body)
    };
  } catch (error) {
    return {
      name,
      ok:false,
      http_status:null,
      latency_ms:Number((performance.now() - started).toFixed(1)),
      error_code:safeCode(error, "SERVICE_READY_REQUEST_FAILED"),
      body:{}
    };
  }
};

export async function runProductionReleasePreflight(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const runtimeDatabase = options.runtimeDatabase || createPostgresClient({
    connectionString:String(env.HUAMEI_DATABASE_URL || env.DATABASE_URL || ""),
    applicationName:"huamei-release-preflight-runtime"
  });
  const controlDatabase = options.controlDatabase || createPostgresClient({
    connectionString:String(env.HUAMEI_MIGRATION_DATABASE_URL || ""),
    applicationName:"huamei-release-preflight-control"
  });
  const redis = options.redis || createRedisClient({ env });
  const owned = {
    runtime:!options.runtimeDatabase,
    control:!options.controlDatabase,
    redis:!options.redis
  };
  const checks = [];
  const configuration = validateReleaseConfiguration(env);
  checks.push(check(
    "release_configuration",
    configuration.ok,
    "RELEASE_CONFIGURATION_INVALID",
    configuration.ok ? "Release identity, immutable images and egress controls are explicit" : "Release configuration is incomplete",
    {
      release_id:configuration.release_id,
      tenant_ids:configuration.tenant_ids,
      model:configuration.model,
      field_encryption:configuration.field_encryption,
      contact_vault:configuration.contact_vault,
      failures:configuration.failures
    }
  ));

  try {
    const evidence = await loadFormalReleaseEvidence(env, { readFileImpl:options.readFileImpl });
    checks.push(check(
      "formal_release_evidence",
      evidence.ok,
      "FORMAL_RELEASE_EVIDENCE_INVALID",
      evidence.ok ? "Formal LLM-enabled evaluation and 20-user capacity evidence match this release" : "Formal release evidence is missing, stale or not approved",
      evidence
    ));
  } catch (error) {
    checks.push(blockedFromError("formal_release_evidence", "FORMAL_RELEASE_EVIDENCE_CHECK_FAILED", "Formal release evidence could not be verified", error));
  }

  let activeBinding = null;
  try {
    const expected = await loadMigrationInventory(options.migrationsRoot || defaultMigrationsRoot);
    const controlEvidence = await controlDatabase.transaction(async (client) => {
      await client.query("SET LOCAL ROLE huamei_owner");
      const identity = await client.query("SELECT current_user, session_user");
      const migrations = await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
      const owners = await client.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','p')
         ORDER BY c.relname`
      );
      const legacyFieldEnvelopes = await client.query(
        legacyFieldEnvelopeInventorySql,
        [LEGACY_FIELD_ENVELOPE_MARKER]
      );
      const roles = await client.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
                rolinherit, rolreplication, rolbypassrls
         FROM pg_roles
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname`,
        [["huamei_owner", "huamei_migrator", "huamei_runtime"]]
      );
      const memberships = await client.query(
        `SELECT parent.rolname AS role_name, member.rolname AS member_name,
                membership.admin_option, membership.inherit_option, membership.set_option
         FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid=membership.roleid
         JOIN pg_roles member ON member.oid=membership.member
         WHERE parent.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
         ORDER BY parent.rolname, member.rolname`,
        [["huamei_owner", "huamei_migrator", "huamei_runtime"]]
      );
      return {
        identity:identity.rows[0],
        migrations:migrations.rows,
        owners:owners.rows,
        legacyFieldEnvelopes:legacyFieldEnvelopes.rows,
        roles:roles.rows,
        memberships:memberships.rows
      };
    });
    const inventory = validateMigrationInventory(expected, controlEvidence.migrations);
    const ownershipFailures = controlEvidence.owners.filter((row) => row.owner !== "huamei_owner")
      .map((row) => row.relname);
    const controlIdentityValid = controlEvidence.identity?.current_user === "huamei_owner"
      && controlEvidence.identity?.session_user === "huamei_migrator";
    const ok = inventory.ok && !ownershipFailures.length && controlIdentityValid;
    checks.push(check(
      "migration_integrity",
      ok,
      "MIGRATION_INTEGRITY_FAILED",
      ok ? "All image migrations match the database checksums and owner" : "Migration checksum, inventory or owner mismatch",
      { ...inventory, owner_mismatches:ownershipFailures, control_identity_valid:controlIdentityValid }
    ));
    const fieldEncryptionCutover = summarizeLegacyFieldEnvelopeInventory(
      controlEvidence.legacyFieldEnvelopes
    );
    checks.push(check(
      "field_encryption_v2_cutover",
      fieldEncryptionCutover.ok,
      "FIELD_ENCRYPTION_LEGACY_ENVELOPES_REMAIN",
      fieldEncryptionCutover.ok
        ? "All protected database fields use the structured AAD v2 envelope"
        : "Legacy field-encryption envelopes remain or the complete inventory could not be proven",
      fieldEncryptionCutover
    ));
    const roleTopology = validateDatabaseRoleTopology({
      roleRows:controlEvidence.roles,
      membershipRows:controlEvidence.memberships
    });
    checks.push(check(
      "database_role_topology",
      roleTopology.ok,
      "DATABASE_ROLE_TOPOLOGY_INVALID",
      roleTopology.ok
        ? "Database owner, migrator and runtime roles have the exact approved attributes and membership edge"
        : "Database role attributes or memberships exceed the approved topology",
      roleTopology
    ));
  } catch (error) {
    checks.push(blockedFromError("migration_integrity", "MIGRATION_INTEGRITY_CHECK_FAILED", "Migration integrity could not be verified", error));
    checks.push(blockedFromError(
      "field_encryption_v2_cutover",
      "FIELD_ENCRYPTION_V2_CUTOVER_CHECK_FAILED",
      "The owner-scoped legacy envelope inventory could not be verified",
      error
    ));
    checks.push(blockedFromError(
      "database_role_topology",
      "DATABASE_ROLE_TOPOLOGY_CHECK_FAILED",
      "Database role attributes and memberships could not be verified",
      error
    ));
  }

  try {
    const [
      identityResult,
      rlsResult,
      privilegeResult,
      ownerResult,
      objectAclEvidence
    ] = await Promise.all([
      runtimeDatabase.query(
        `SELECT current_user, session_user, rolcanlogin, rolsuper, rolcreaterole,
           rolcreatedb, rolinherit, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname=current_user`
      ),
      runtimeDatabase.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [tenantTables]
      ),
      runtimeDatabase.query(
        `SELECT
           has_schema_privilege(current_user,'public','CREATE') AS schema_create,
           has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
           has_table_privilege(current_user,'knowledge_releases','INSERT') AS knowledge_release_insert,
           has_table_privilege(current_user,'knowledge_releases','UPDATE') AS knowledge_release_update,
           has_table_privilege(current_user,'knowledge_releases','DELETE') AS knowledge_release_delete,
           has_table_privilege(current_user,'knowledge_reviews','INSERT') AS knowledge_review_insert,
           has_table_privilege(current_user,'knowledge_reviews','UPDATE') AS knowledge_review_update,
           has_table_privilege(current_user,'knowledge_reviews','DELETE') AS knowledge_review_delete,
           has_table_privilege(current_user,'audit_events','UPDATE') AS audit_update,
           has_table_privilege(current_user,'audit_events','DELETE') AS audit_delete`
      ),
      runtimeDatabase.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','p')`
      ),
      loadRuntimeObjectAclEvidence(runtimeDatabase)
    ]);
    const evidence = validateRuntimeSecurityEvidence({
      identity:identityResult.rows[0],
      rlsRows:rlsResult.rows,
      privilegeEvidence:privilegeResult.rows[0] || {},
      ownerRows:ownerResult.rows,
      ...objectAclEvidence
    });
    checks.push(check(
      "runtime_least_privilege_and_force_rls",
      evidence.ok,
      "RUNTIME_SECURITY_INVARIANT_FAILED",
      evidence.ok ? "Runtime role is least privilege and every tenant table uses FORCE RLS" : "Runtime role or FORCE RLS invariant failed",
      evidence
    ));
  } catch (error) {
    checks.push(blockedFromError("runtime_least_privilege_and_force_rls", "RUNTIME_SECURITY_CHECK_FAILED", "Runtime database security could not be verified", error));
  }

  for (const tenantId of configuration.tenant_ids) {
    try {
      const releases = await runtimeDatabase.tenantQuery(tenantId,
        `SELECT release_id, package_version, status, is_active, package_checksum,
           record_list_checksum, index_checksum, index_version, manifest,
           effective_at, expires_at
         FROM knowledge_releases
         WHERE tenant_id=$1 AND is_active
         ORDER BY activated_at DESC`,
        [tenantId]
      );
      const reviews = releases.rows[0] ? await runtimeDatabase.tenantQuery(tenantId,
        `SELECT v.id::text, v.review_type, v.reviewer_id, v.decision, v.evidence
         FROM knowledge_reviews v
         JOIN knowledge_releases r ON r.tenant_id=v.tenant_id AND r.id=v.release_record_id
         WHERE v.tenant_id=$1 AND r.release_id=$2
         ORDER BY v.review_type`,
        [tenantId, releases.rows[0].release_id]
      ) : { rows:[] };
      const validation = validateActiveKnowledgeRelease(tenantId, releases.rows, reviews.rows);
      if (validation.binding?.index_version !== String(env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim()) {
        validation.failures.push("ACTIVE_RELEASE_CONFIGURED_INDEX_MISMATCH");
      }
      if (validation.binding?.manifest_sha256 !== String(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase()) {
        validation.failures.push("ACTIVE_RELEASE_CONFIGURED_MANIFEST_MISMATCH");
      }
      if (validation.binding?.release_id !== String(env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID || "").trim()) {
        validation.failures.push("ACTIVE_RELEASE_CONFIGURED_ID_MISMATCH");
      }
      validation.ok = validation.failures.length === 0;
      if (validation.ok) activeBinding = validation.binding;
      checks.push(check(
        `active_knowledge_release:${tenantId}`,
        validation.ok,
        "ACTIVE_KNOWLEDGE_RELEASE_INVALID",
        validation.ok ? "Active release is effective and bound to three reviews and one immutable index" : "Active knowledge release binding is invalid",
        { failures:validation.failures, binding:validation.binding }
      ));
    } catch (error) {
      checks.push(blockedFromError(`active_knowledge_release:${tenantId}`, "ACTIVE_KNOWLEDGE_RELEASE_CHECK_FAILED", "Active knowledge release could not be verified", error));
    }
  }

  try {
    const health = await redis.health();
    checks.push(check(
      "redis_ready",
      health.ok === true,
      "REDIS_NOT_READY",
      health.ok ? "Redis answered PING" : "Redis is not ready",
      { status:health.status, latency_ms:health.latency_ms ?? null, error_code:health.error?.code || null }
    ));
  } catch (error) {
    checks.push(blockedFromError("redis_ready", "REDIS_READY_CHECK_FAILED", "Redis readiness could not be verified", error));
  }

  const timeoutMs = Math.min(30_000, Math.max(500, Number(env.HUAMEI_RELEASE_PREFLIGHT_TIMEOUT_MS) || 5_000));
  const graphBase = String(env.HUAMEI_GRAPHRAG_URL || "").trim().replace(/\/+$/, "");
  const readyRequests = [
    {
      name:"graphrag",
      url:`${graphBase}/ready`,
      headers:String(env.HUAMEI_GRAPHRAG_SERVICE_KEY || "").trim()
        ? { "X-Service-Key":String(env.HUAMEI_GRAPHRAG_SERVICE_KEY).trim() }
        : {}
    },
    {
      name:"acquisition",
      url:String(env.HUAMEI_RELEASE_ACQUISITION_READY_URL || "http://acquisition:4180/ready"),
      headers:{
        "X-Caller-Id":String(env.HUAMEI_ACQUISITION_CALLER_ID || ""),
        "X-Service-Key":String(env.HUAMEI_ACQUISITION_CALLER_SECRET || ""),
        "X-Tenant-Id":String(env.HUAMEI_PUBLIC_TENANT_ID || configuration.tenant_ids[0] || "")
      }
    },
    {
      name:"app",
      url:String(env.HUAMEI_RELEASE_APP_READY_URL || "http://app:4173/api/ready"),
      headers:{ "X-API-Key":String(env.HUAMEI_API_KEY || "") }
    }
  ];
  for (const request of readyRequests) {
    if (!request.url || request.url === "/ready") {
      checks.push(check(`service_ready:${request.name}`, false, "SERVICE_READY_URL_REQUIRED", `${request.name} readiness URL is missing`));
      continue;
    }
    const result = await fetchReady({ ...request, fetchImpl, timeoutMs });
    if (request.name === "graphrag") {
      const validation = validateGraphRagReadyBinding(activeBinding, result.body);
      const ok = result.ok && validation.ok;
      checks.push(check(
        "service_ready:graphrag",
        ok,
        "GRAPHRAG_RELEASE_BINDING_NOT_READY",
        ok ? "GraphRAG loaded the exact active release manifest" : "GraphRAG readiness does not match the active release",
        { http_status:result.http_status, latency_ms:result.latency_ms, error_code:result.error_code || null, failures:validation.failures }
      ));
    } else {
      const validation = validateApplicationReadyBinding(request.name, result.body, env);
      const ok = result.ok && validation.ok;
      checks.push(check(
        `service_ready:${request.name}`,
        ok,
        "SERVICE_RUNTIME_BINDING_NOT_READY",
        ok ? `${request.name} service has the approved LLM and field encryption ready` : `${request.name} service runtime binding is not ready`,
        { http_status:result.http_status, latency_ms:result.latency_ms, error_code:result.error_code || null, failures:validation.failures }
      ));
    }
  }

  if (owned.runtime || owned.control || owned.redis) {
    await Promise.allSettled([
      owned.runtime ? runtimeDatabase.close() : Promise.resolve(),
      owned.control ? controlDatabase.close() : Promise.resolve(),
      owned.redis ? redis.close() : Promise.resolve()
    ]);
  }
  const ready = checks.every((item) => item.status === "pass");
  return {
    schema_version:RELEASE_PREFLIGHT_SCHEMA,
    status:ready ? "ready" : "blocked",
    release_id:configuration.release_id,
    checked_at:new Date().toISOString(),
    checks
  };
}

async function runCli() {
  try {
    const report = await runProductionReleasePreflight();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "ready") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      schema_version:RELEASE_PREFLIGHT_SCHEMA,
      status:"blocked",
      code:safeCode(error, "RELEASE_PREFLIGHT_FATAL"),
      message:"Production release preflight could not complete"
    }, null, 2));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) await runCli();
