import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA = "huamei.formal-load-taxonomy-manifest.v1";
export const FORMAL_LOAD_TAXONOMY_APPROVAL_SCHEMA = "huamei.formal-load-taxonomy-approval.v1";
export const FORMAL_LOAD_TAXONOMY_CATALOG_SCHEMA = "huamei.formal-load-taxonomy-catalog.v1";
export const FORMAL_LOAD_TAXONOMY_ALGORITHM = "factoradic-token-permutation.v1";
export const FORMAL_LOAD_TAXONOMY_PERMISSION = "formal-load:execute";
export const FORMAL_LOAD_TAXONOMY_HEADER = "x-huamei-formal-load-entry-id";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,191}$/;
const ENTRY_ID_PATTERN = /^([a-z][a-z0-9_-]{1,31})\.([0-9]{1,6})$/;
const FORMAL_ENVIRONMENTS = new Set(["preproduction", "production"]);
const catalogPath = fileURLToPath(new URL("../../config/formal-load-taxonomy-catalog.v1.json", import.meta.url));

// This is deliberately duplicated from the GraphRAG privacy boundary.  The
// bundled catalog may use only these reviewed, non-personal business terms;
// neither the external manifest nor a request can extend this set.
const FIXED_REVIEWED_TERMS = new Set([
  "双眼皮", "眼部整形", "项目介绍", "自然", "手术方式", "恢复期", "医生", "擅长", "流程",
  "丰胸", "胸部整形", "自体脂肪", "胎记", "皮肤美容", "面部", "专业方向", "服务",
  "面部年轻化", "热玛吉", "拉皮", "微拉美", "光子嫩肤", "色斑"
]);
const REQUIRED_CHECKLIST = Object.freeze([
  "privacy_boundary_reviewed",
  "taxonomy_catalog_reviewed",
  "cache_resistance_plan_reviewed",
  "model_cost_and_quota_approved",
  "load_window_approved",
  "rollback_owner_confirmed"
]);

const canonicalJsonValue = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonValue(item)}`).join(",")}}`;
};

const canonicalJsonBytes = (value) => Buffer.from(canonicalJsonValue(value), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const validTimestamp = (value) => Number.isFinite(Date.parse(String(value || "")));
const safeReference = (value) => SAFE_REFERENCE_PATTERN.test(String(value || ""));
const normalizedEnvironment = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "prod") return "production";
  if (normalized === "preprod") return "preproduction";
  return normalized;
};

const taxonomyError = (code, message = code, status = 503, details = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const factorial = (value) => {
  let result = 1;
  for (let current = 2; current <= value; current += 1) result *= current;
  return result;
};

export const queryForFormalLoadTaxonomyEntry = (profile, ordinal) => {
  const terms = Array.isArray(profile?.terms) ? [...profile.terms] : [];
  const maximum = factorial(terms.length);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= maximum) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_ENTRY_OUT_OF_RANGE", "正式压测taxonomy entry超出批准范围", 400);
  }
  const remaining = [...terms];
  const ordered = [];
  let rank = ordinal;
  for (let width = remaining.length; width > 0; width -= 1) {
    const block = factorial(width - 1);
    const index = Math.floor(rank / block);
    rank %= block;
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered.join(" ");
};

const validateCatalog = (catalog, bytes) => {
  if (catalog.schema_version !== FORMAL_LOAD_TAXONOMY_CATALOG_SCHEMA
    || catalog.algorithm_version !== FORMAL_LOAD_TAXONOMY_ALGORITHM) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_CATALOG_SCHEMA_INVALID");
  }
  const profiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  if (profiles.length < 5) throw taxonomyError("FORMAL_LOAD_TAXONOMY_CATALOG_PROFILES_INSUFFICIENT");
  const ids = new Set();
  const journeys = new Set();
  const normalizedProfiles = profiles.map((profile) => {
    const id = String(profile?.id || "");
    const journeyIndex = Number(profile?.journey_index);
    const terms = Array.isArray(profile?.terms) ? profile.terms.map((term) => String(term || "").trim()) : [];
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id) || ids.has(id)
      || !Number.isInteger(journeyIndex) || journeyIndex < 0 || journeys.has(journeyIndex)
      || terms.length !== 9 || new Set(terms).size !== terms.length
      || terms.some((term) => !FIXED_REVIEWED_TERMS.has(term))) {
      throw taxonomyError("FORMAL_LOAD_TAXONOMY_CATALOG_CONTENT_INVALID");
    }
    ids.add(id);
    journeys.add(journeyIndex);
    return Object.freeze({ id, journeyIndex, terms:Object.freeze(terms), capacity:factorial(terms.length) });
  });
  return Object.freeze({
    schemaVersion:catalog.schema_version,
    algorithmVersion:catalog.algorithm_version,
    sha256:sha256(bytes),
    profiles:Object.freeze(normalizedProfiles),
    profilesById:new Map(normalizedProfiles.map((profile) => [profile.id, profile]))
  });
};

const catalogBytes = await readFile(catalogPath);
const catalog = validateCatalog(JSON.parse(catalogBytes.toString("utf8")), catalogBytes);

export const getFormalLoadTaxonomyCatalog = () => catalog;

const unsignedManifest = (manifest) => {
  const copy = structuredClone(objectValue(manifest));
  delete copy.approval_attestation;
  return copy;
};

const approvalPayload = (manifest, attestation) => canonicalJsonBytes({
  schema_version:FORMAL_LOAD_TAXONOMY_APPROVAL_SCHEMA,
  manifest_schema_version:FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA,
  signer_id:String(attestation.signer_id || ""),
  signature_algorithm:"ed25519",
  signed_at:String(attestation.signed_at || ""),
  document:unsignedManifest(manifest)
});

const parseTrustedSigners = (encoded) => {
  try { return objectValue(JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"))); }
  catch { return {}; }
};

export function signFormalLoadTaxonomyManifest(manifest, options = {}) {
  const signerId = String(options.signerId || "").trim();
  if (!safeReference(signerId)) throw taxonomyError("FORMAL_LOAD_TAXONOMY_SIGNER_ID_INVALID", undefined, 400);
  let privateKey;
  try { privateKey = options.privateKey?.type === "private" ? options.privateKey : createPrivateKey(options.privateKey); }
  catch { throw taxonomyError("FORMAL_LOAD_TAXONOMY_PRIVATE_KEY_INVALID", undefined, 400); }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_ED25519_KEY_REQUIRED", undefined, 400);
  }
  const signedAt = options.signedAt || new Date().toISOString();
  if (!validTimestamp(signedAt)) throw taxonomyError("FORMAL_LOAD_TAXONOMY_SIGNED_AT_INVALID", undefined, 400);
  const unsigned = unsignedManifest(manifest);
  const protectedFields = { signer_id:signerId, signed_at:signedAt };
  const payload = approvalPayload(unsigned, protectedFields);
  return {
    ...unsigned,
    approval_attestation:{
      schema_version:FORMAL_LOAD_TAXONOMY_APPROVAL_SCHEMA,
      signer_id:signerId,
      signature_algorithm:"ed25519",
      signed_payload_sha256:sha256(payload),
      signed_at:signedAt,
      signature_base64:cryptoSign(null, payload, privateKey).toString("base64")
    }
  };
}

const verifyManifestApproval = (manifest, trustedSigners) => {
  const attestation = objectValue(manifest.approval_attestation);
  if (attestation.schema_version !== FORMAL_LOAD_TAXONOMY_APPROVAL_SCHEMA
    || attestation.signature_algorithm !== "ed25519" || !safeReference(attestation.signer_id)
    || !validTimestamp(attestation.signed_at)) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_APPROVAL_ATTESTATION_INVALID");
  }
  const trusted = objectValue(trustedSigners[attestation.signer_id]);
  const allowedSchemas = Array.isArray(trusted.allowed_schemas) ? trusted.allowed_schemas.map(String) : [];
  const tenantIds = Array.isArray(trusted.tenant_ids) ? trusted.tenant_ids.map(String) : [];
  if (trusted.authority_role !== "formal_load_taxonomy_approver"
    || !allowedSchemas.includes(FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA)
    || !tenantIds.includes(String(manifest.tenant_id || ""))) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_SIGNER_UNTRUSTED");
  }
  const payload = approvalPayload(manifest, attestation);
  if (attestation.signed_payload_sha256 !== sha256(payload)) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_SIGNED_PAYLOAD_SHA256_MISMATCH");
  }
  let publicKey;
  let signature;
  try {
    publicKey = createPublicKey({
      key:Buffer.from(String(trusted.public_key_spki_der_base64 || ""), "base64"),
      format:"der",
      type:"spki"
    });
    signature = Buffer.from(String(attestation.signature_base64 || ""), "base64");
  } catch {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_SIGNER_PUBLIC_KEY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64
    || !cryptoVerify(null, payload, publicKey, signature)) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_APPROVAL_SIGNATURE_INVALID");
  }
  return Object.freeze({
    signerId:attestation.signer_id,
    signedAt:attestation.signed_at,
    signedPayloadSha256:attestation.signed_payload_sha256
  });
};

const requiredBinding = (env) => ({
  tenantId:String(env.HUAMEI_RELEASE_TENANT_ID || env.HUAMEI_PUBLIC_TENANT_ID || "").trim().toLowerCase(),
  environment:normalizedEnvironment(env.HUAMEI_EVIDENCE_ENVIRONMENT || env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV),
  releaseId:String(env.HUAMEI_RELEASE_ID || "").trim(),
  knowledgeReleaseId:String(env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID || "").trim(),
  indexVersion:String(env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim(),
  knowledgeManifestSha256:String(env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase()
});

const validateManifest = (manifest, context) => {
  if (manifest.schema_version !== FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA
    || !safeReference(manifest.manifest_id)) throw taxonomyError("FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA_INVALID");
  const binding = requiredBinding(context.env);
  if (!FORMAL_ENVIRONMENTS.has(binding.environment)) throw taxonomyError("FORMAL_LOAD_TAXONOMY_ENVIRONMENT_NOT_FORMAL");
  for (const [field, expected] of [
    ["tenant_id", binding.tenantId], ["environment", binding.environment], ["release_id", binding.releaseId],
    ["knowledge_release_id", binding.knowledgeReleaseId], ["index_version", binding.indexVersion],
    ["knowledge_manifest_sha256", binding.knowledgeManifestSha256], ["catalog_sha256", catalog.sha256],
    ["algorithm_version", catalog.algorithmVersion]
  ]) {
    if (!expected || String(manifest[field] || "") !== expected) {
      throw taxonomyError("FORMAL_LOAD_TAXONOMY_MANIFEST_BINDING_MISMATCH", undefined, 503, { field });
    }
  }
  const notBefore = Date.parse(String(manifest.not_before || ""));
  const notAfter = Date.parse(String(manifest.not_after || ""));
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore
    || context.now < notBefore || context.now > notAfter) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_APPROVAL_WINDOW_INVALID");
  }
  const approval = objectValue(manifest.approval);
  const checklist = objectValue(approval.checklist);
  if (approval.status !== "approved" || !safeReference(approval.approval_id)
    || !safeReference(approval.approved_by) || !validTimestamp(approval.approved_at)
    || Date.parse(approval.approved_at) > Date.parse(String(manifest.approval_attestation?.signed_at || ""))
    || REQUIRED_CHECKLIST.some((item) => checklist[item] !== true)) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_APPROVAL_CHECKLIST_INVALID");
  }
  const allowedProfiles = Array.isArray(manifest.allowed_profile_ids)
    ? [...new Set(manifest.allowed_profile_ids.map(String))] : [];
  const ordinalLimit = Number(manifest.max_ordinal_per_profile);
  const maximumRequests = Number(manifest.maximum_requests);
  if (!allowedProfiles.length || allowedProfiles.some((id) => !catalog.profilesById.has(id))
    || !Number.isSafeInteger(ordinalLimit) || ordinalLimit < 500 || catalog.profiles.some((profile) => ordinalLimit > profile.capacity)
    || !Number.isSafeInteger(maximumRequests) || maximumRequests < 2_500
    || maximumRequests > ordinalLimit * allowedProfiles.length) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_CAPACITY_INVALID");
  }
  const signer = verifyManifestApproval(manifest, context.trustedSigners);
  return Object.freeze({
    manifestId:manifest.manifest_id,
    manifestSha256:context.manifestSha256,
    tenantId:manifest.tenant_id,
    environment:manifest.environment,
    releaseId:manifest.release_id,
    knowledgeReleaseId:manifest.knowledge_release_id,
    indexVersion:manifest.index_version,
    knowledgeManifestSha256:manifest.knowledge_manifest_sha256,
    catalogSha256:manifest.catalog_sha256,
    algorithmVersion:manifest.algorithm_version,
    notBefore:manifest.not_before,
    notAfter:manifest.not_after,
    allowedProfileIds:Object.freeze(allowedProfiles),
    maxOrdinalPerProfile:ordinalLimit,
    maximumRequests,
    signer
  });
};

let manifestCache = null;
const validatedSelections = new WeakSet();

export const readFormalLoadTaxonomyConfig = (env = process.env) => ({
  enabled:String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED || "false").trim().toLowerCase() === "true",
  manifestPath:String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_PATH || "").trim(),
  manifestSha256:String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256 || "").trim().toLowerCase(),
  trustedSigners:parseTrustedSigners(env.HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64)
});

export async function loadFormalLoadTaxonomyManifest(options = {}) {
  const env = options.env || process.env;
  const config = readFormalLoadTaxonomyConfig(env);
  if (!config.enabled) throw taxonomyError("FORMAL_LOAD_TAXONOMY_DISABLED", undefined, 403);
  if (!isAbsolute(config.manifestPath) || !SHA256_PATTERN.test(config.manifestSha256)
    || !Object.keys(config.trustedSigners).length) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_CONFIGURATION_INVALID");
  }
  // The immutable manifest bytes may be cached, but the cache identity must
  // include every runtime binding and the trusted signer registry.  Otherwise
  // a long-lived process could accept a manifest verified under a previous
  // release/index/tenant or signer configuration.
  const binding = requiredBinding(env);
  const cacheKey = sha256(canonicalJsonBytes({
    manifest_path:config.manifestPath,
    manifest_sha256:config.manifestSha256,
    trusted_signers_sha256:sha256(canonicalJsonBytes(config.trustedSigners)),
    binding
  }));
  if (manifestCache?.key === cacheKey) {
    // The approval window is deliberately checked on every request even when
    // immutable bytes, bindings, and signature have already been verified.
    const now = Number(options.now ?? Date.now());
    if (now < Date.parse(manifestCache.value.notBefore) || now > Date.parse(manifestCache.value.notAfter)) {
      throw taxonomyError("FORMAL_LOAD_TAXONOMY_APPROVAL_WINDOW_INVALID");
    }
    return manifestCache.value;
  }
  const bytes = await (options.readFileImpl || readFile)(config.manifestPath);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length || buffer.length > 512 * 1024 || sha256(buffer) !== config.manifestSha256) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256_MISMATCH");
  }
  let manifest;
  try { manifest = JSON.parse(buffer.toString("utf8")); }
  catch { throw taxonomyError("FORMAL_LOAD_TAXONOMY_MANIFEST_JSON_INVALID"); }
  const value = validateManifest(manifest, {
    env,
    now:Number(options.now ?? Date.now()),
    trustedSigners:config.trustedSigners,
    manifestSha256:config.manifestSha256
  });
  manifestCache = { key:cacheKey, value };
  return value;
}

export async function resolveFormalLoadTaxonomyEntry(entryId, options = {}) {
  const normalizedEntryId = String(entryId || "").trim();
  const match = normalizedEntryId.match(ENTRY_ID_PATTERN);
  if (!match) throw taxonomyError("FORMAL_LOAD_TAXONOMY_ENTRY_ID_INVALID", undefined, 400);
  const manifest = await loadFormalLoadTaxonomyManifest(options);
  const profile = catalog.profilesById.get(match[1]);
  const ordinal = Number(match[2]);
  if (!profile || !manifest.allowedProfileIds.includes(profile.id)
    || !Number.isSafeInteger(ordinal) || ordinal >= manifest.maxOrdinalPerProfile) {
    throw taxonomyError("FORMAL_LOAD_TAXONOMY_ENTRY_NOT_APPROVED", undefined, 403);
  }
  const query = queryForFormalLoadTaxonomyEntry(profile, ordinal);
  const selection = Object.freeze({
    entryId:normalizedEntryId,
    profileId:profile.id,
    journeyIndex:profile.journeyIndex,
    ordinal,
    query,
    querySha256:sha256(Buffer.from(query, "utf8")),
    manifestId:manifest.manifestId,
    manifestSha256:manifest.manifestSha256,
    signerId:manifest.signer.signerId,
    signedPayloadSha256:manifest.signer.signedPayloadSha256,
    tenantId:manifest.tenantId,
    releaseId:manifest.releaseId,
    knowledgeReleaseId:manifest.knowledgeReleaseId,
    indexVersion:manifest.indexVersion,
    knowledgeManifestSha256:manifest.knowledgeManifestSha256,
    catalogSha256:manifest.catalogSha256,
    algorithmVersion:manifest.algorithmVersion
  });
  validatedSelections.add(selection);
  return selection;
}

export const isValidatedFormalLoadTaxonomyEntry = (value) => Boolean(
  value && typeof value === "object" && validatedSelections.has(value)
);

export const resetFormalLoadTaxonomyForTest = () => { manifestCache = null; };
