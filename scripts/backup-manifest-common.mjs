import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as openFile, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  canonicalJsonBytes,
  evidenceError,
  objectValue,
  parseTrustedSignerRegistry,
  readJsonWithSha,
  safeReference,
  sha256,
  uniqueStrings,
  validSha256,
  validTimestamp
} from "./formal-evidence-common.mjs";

export const BACKUP_MANIFEST_SCHEMA = "huamei.postgres-backup-manifest.v1";
export const BACKUP_MANIFEST_ATTESTATION_SCHEMA = "huamei.postgres-backup-manifest-attestation.v1";
export const BACKUP_MANIFEST_KIND = "postgres_backup_manifest";
export const BACKUP_MANIFEST_AUTHORITY = "backup_operator";
export const BACKUP_STORAGE_ATTESTATION_SCHEMA = "huamei.backup-storage-artifact-attestation.v1";
export const BACKUP_STORAGE_ATTESTATION_SIGNATURE_SCHEMA = "huamei.backup-storage-artifact-attestation-signature.v1";
export const BACKUP_STORAGE_ATTESTATION_KIND = "backup_storage_artifact";
export const BACKUP_STORAGE_ATTESTATION_AUTHORITY = "backup_storage_verifier";
export const RESTORE_CRITICAL_TABLES = Object.freeze([
  "tenants", "conversation_sessions", "conversation_messages", "leads", "lead_candidates", "consents",
  "handovers", "tasks", "human_work", "knowledge_releases", "knowledge_reviews", "audit_events",
  "outbox_events", "idempotency_records", "agent_runs", "data_migration_batches", "data_subject_requests",
  "contact_suppressions", "privacy_execution_actions", "privacy_identity_verifications",
  "privacy_completion_verifications", "contact_vault_entries", "agent_turn_results", "agent_effect_ledger",
  "agent_turn_leases", "appointment_sessions", "knowledge_intake_state", "knowledge_intake_assets", "knowledge_publication_packages", "knowledge_publication_events", "knowledge_publication_heads", "management_accounts"
]);

const unsignedManifest = (manifest) => {
  const copy = structuredClone(objectValue(manifest));
  delete copy.execution_attestation;
  return copy;
};

const unsignedStorageAttestation = (attestation) => {
  const copy = structuredClone(objectValue(attestation));
  delete copy.execution_attestation;
  return copy;
};

const storageAttestationPayload = (document, attestation) => canonicalJsonBytes({
  schema_version:BACKUP_STORAGE_ATTESTATION_SIGNATURE_SCHEMA,
  evidence_kind:BACKUP_STORAGE_ATTESTATION_KIND,
  signer_id:String(attestation.signer_id || ""),
  signature_algorithm:"ed25519",
  signed_at:String(attestation.signed_at || ""),
  document:unsignedStorageAttestation(document)
});

const attestationPayload = (manifest, attestation) => canonicalJsonBytes({
  schema_version:BACKUP_MANIFEST_ATTESTATION_SCHEMA,
  evidence_kind:BACKUP_MANIFEST_KIND,
  signer_id:String(attestation.signer_id || ""),
  signature_algorithm:"ed25519",
  signed_at:String(attestation.signed_at || ""),
  document:unsignedManifest(manifest)
});

const activeReleaseKey = (release) => [
  String(release.tenant_id || ""),
  String(release.release_id || ""),
  String(release.index_version || "")
].join("\n");

const normalizeActiveRelease = (release) => ({
  tenant_id:String(release.tenant_id || ""),
  release_id:String(release.release_id || ""),
  index_version:String(release.index_version || ""),
  package_checksum:String(release.package_checksum || "").toLowerCase(),
  record_list_checksum:String(release.record_list_checksum || "").toLowerCase(),
  index_checksum:String(release.index_checksum || "").toLowerCase()
});

const normalizeAuditAnchor = (anchor) => ({
  tenant_id:String(anchor.tenant_id || ""),
  event_id:String(anchor.event_id || ""),
  occurred_at:new Date(anchor.occurred_at).toISOString()
});

export function validateBackupManifestStructure(manifest = {}) {
  const document = objectValue(manifest);
  const failures = [];
  if (document.schema_version !== BACKUP_MANIFEST_SCHEMA) failures.push("BACKUP_MANIFEST_SCHEMA_INVALID");
  if (!safeReference(document.backup_id)) failures.push("BACKUP_MANIFEST_ID_INVALID");
  if (!safeReference(document.database_instance_id)) failures.push("BACKUP_MANIFEST_DATABASE_INSTANCE_INVALID");
  for (const field of ["backup_started_at", "backup_completed_at", "restore_point"]) {
    if (!validTimestamp(document[field])) failures.push(`BACKUP_MANIFEST_${field.toUpperCase()}_INVALID`);
  }
  const started = Date.parse(String(document.backup_started_at || ""));
  const completed = Date.parse(String(document.backup_completed_at || ""));
  const restorePoint = Date.parse(String(document.restore_point || ""));
  if (Number.isFinite(started) && Number.isFinite(completed) && completed < started) {
    failures.push("BACKUP_MANIFEST_TIME_ORDER_INVALID");
  }
  if (Number.isFinite(completed) && Number.isFinite(restorePoint) && restorePoint > completed) {
    failures.push("BACKUP_MANIFEST_RESTORE_POINT_AFTER_COMPLETION");
  }
  const artifact = objectValue(document.artifact);
  if (!safeReference(artifact.object_version_id)) failures.push("BACKUP_MANIFEST_OBJECT_VERSION_INVALID");
  if (!validSha256(artifact.sha256)) failures.push("BACKUP_MANIFEST_ARTIFACT_SHA256_INVALID");
  if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes <= 0) failures.push("BACKUP_MANIFEST_ARTIFACT_SIZE_INVALID");

  const counts = objectValue(document.critical_table_counts);
  for (const table of RESTORE_CRITICAL_TABLES) {
    if (!Number.isSafeInteger(counts[table]) || counts[table] < 0) {
      failures.push(`BACKUP_MANIFEST_TABLE_COUNT_INVALID:${table}`);
    }
  }
  const totalRows = RESTORE_CRITICAL_TABLES.reduce((total, table) => total + (Number.isSafeInteger(counts[table]) ? counts[table] : 0), 0);
  if (totalRows <= 0 || !(counts.tenants > 0) || !(counts.knowledge_releases > 0) || !(counts.audit_events > 0)) {
    failures.push("BACKUP_MANIFEST_EMPTY_DATASET");
  }

  const releases = Array.isArray(document.active_knowledge_releases) ? document.active_knowledge_releases : [];
  if (!releases.length) failures.push("BACKUP_MANIFEST_ACTIVE_RELEASES_EMPTY");
  if (releases.length > 100) failures.push("BACKUP_MANIFEST_ACTIVE_RELEASES_EXCESSIVE");
  const releaseKeys = new Set();
  const releaseTenants = new Set();
  for (const release of releases) {
    const normalized = normalizeActiveRelease(objectValue(release));
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(normalized.tenant_id)) failures.push("BACKUP_MANIFEST_ACTIVE_RELEASE_TENANT_INVALID");
    if (!safeReference(normalized.release_id) || !safeReference(normalized.index_version)) failures.push("BACKUP_MANIFEST_ACTIVE_RELEASE_ID_INVALID");
    for (const field of ["package_checksum", "record_list_checksum", "index_checksum"]) {
      if (!validSha256(normalized[field])) failures.push(`BACKUP_MANIFEST_ACTIVE_RELEASE_${field.toUpperCase()}_INVALID`);
    }
    const key = activeReleaseKey(normalized);
    if (releaseKeys.has(key)) failures.push("BACKUP_MANIFEST_ACTIVE_RELEASE_DUPLICATE");
    releaseKeys.add(key);
    if (releaseTenants.has(normalized.tenant_id)) failures.push("BACKUP_MANIFEST_MULTIPLE_ACTIVE_RELEASES_PER_TENANT");
    releaseTenants.add(normalized.tenant_id);
  }

  const anchors = Array.isArray(document.audit_anchors) ? document.audit_anchors : [];
  if (!anchors.length) failures.push("BACKUP_MANIFEST_AUDIT_ANCHORS_EMPTY");
  if (anchors.length > 100) failures.push("BACKUP_MANIFEST_AUDIT_ANCHORS_EXCESSIVE");
  const anchorTenants = new Set();
  for (const anchor of anchors) {
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(String(anchor?.tenant_id || ""))
      || !safeReference(anchor?.event_id)
      || !validTimestamp(anchor?.occurred_at)) {
      failures.push("BACKUP_MANIFEST_AUDIT_ANCHOR_INVALID");
      continue;
    }
    if (anchorTenants.has(anchor.tenant_id)) failures.push("BACKUP_MANIFEST_AUDIT_ANCHOR_DUPLICATE_TENANT");
    anchorTenants.add(anchor.tenant_id);
  }
  for (const release of releases) {
    if (!anchorTenants.has(release.tenant_id)) failures.push(`BACKUP_MANIFEST_AUDIT_ANCHOR_MISSING:${release.tenant_id}`);
  }
  return { ok:failures.length === 0, failures, total_rows:totalRows };
}

export function signBackupManifest(manifest, options = {}) {
  const structure = validateBackupManifestStructure(manifest);
  if (!structure.ok) throw evidenceError("BACKUP_MANIFEST_INVALID", "Backup manifest is invalid", { failures:structure.failures });
  const signerId = String(options.signerId || "").trim();
  if (!safeReference(signerId)) throw evidenceError("BACKUP_MANIFEST_SIGNER_ID_INVALID");
  let privateKey;
  try { privateKey = options.privateKey?.type === "private" ? options.privateKey : createPrivateKey(options.privateKey); }
  catch { throw evidenceError("BACKUP_MANIFEST_PRIVATE_KEY_INVALID"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw evidenceError("BACKUP_MANIFEST_ED25519_KEY_REQUIRED");
  const signedAt = options.signedAt || new Date().toISOString();
  if (!validTimestamp(signedAt)) throw evidenceError("BACKUP_MANIFEST_SIGNED_AT_INVALID");
  if (Date.parse(signedAt) < Date.parse(manifest.backup_completed_at)) throw evidenceError("BACKUP_MANIFEST_SIGNED_BEFORE_COMPLETION");
  const protectedFields = { signer_id:signerId, signed_at:signedAt };
  const payload = attestationPayload(manifest, protectedFields);
  return {
    ...unsignedManifest(manifest),
    execution_attestation:{
      schema_version:BACKUP_MANIFEST_ATTESTATION_SCHEMA,
      evidence_kind:BACKUP_MANIFEST_KIND,
      signer_id:signerId,
      signature_algorithm:"ed25519",
      signed_payload_sha256:sha256(payload),
      signed_at:signedAt,
      signature_base64:cryptoSign(null, payload, privateKey).toString("base64")
    }
  };
}

export function verifyBackupManifest(manifest, options = {}) {
  const failures = [...validateBackupManifestStructure(manifest).failures];
  const attestation = objectValue(manifest.execution_attestation);
  if (attestation.schema_version !== BACKUP_MANIFEST_ATTESTATION_SCHEMA) failures.push("BACKUP_MANIFEST_ATTESTATION_SCHEMA_INVALID");
  if (attestation.evidence_kind !== BACKUP_MANIFEST_KIND) failures.push("BACKUP_MANIFEST_ATTESTATION_KIND_INVALID");
  if (attestation.signature_algorithm !== "ed25519") failures.push("BACKUP_MANIFEST_ATTESTATION_ALGORITHM_INVALID");
  if (!safeReference(attestation.signer_id)) failures.push("BACKUP_MANIFEST_ATTESTATION_SIGNER_INVALID");
  if (!validTimestamp(attestation.signed_at)) failures.push("BACKUP_MANIFEST_ATTESTATION_TIMESTAMP_INVALID");
  if (validTimestamp(attestation.signed_at)
    && validTimestamp(manifest.backup_completed_at)
    && Date.parse(attestation.signed_at) < Date.parse(manifest.backup_completed_at)) {
    failures.push("BACKUP_MANIFEST_ATTESTATION_BEFORE_COMPLETION");
  }
  const registry = parseTrustedSignerRegistry(options.trustedSigners);
  const trusted = objectValue(registry[attestation.signer_id]);
  if (!Object.keys(trusted).length) failures.push("BACKUP_MANIFEST_SIGNER_UNTRUSTED");
  if (trusted.authority_role !== BACKUP_MANIFEST_AUTHORITY) failures.push("BACKUP_MANIFEST_SIGNER_AUTHORITY_INVALID");
  if (!uniqueStrings(trusted.allowed_kinds).includes(BACKUP_MANIFEST_KIND)) failures.push("BACKUP_MANIFEST_KIND_NOT_ALLOWED");
  const payload = attestationPayload(manifest, attestation);
  const payloadSha = sha256(payload);
  if (attestation.signed_payload_sha256 !== payloadSha) failures.push("BACKUP_MANIFEST_PAYLOAD_SHA256_MISMATCH");
  let signerFingerprint = null;
  if (!failures.length) {
    try {
      const publicKey = createPublicKey({
        key:Buffer.from(String(trusted.public_key_spki_der_base64 || ""), "base64"),
        format:"der",
        type:"spki"
      });
      const signature = Buffer.from(String(attestation.signature_base64 || ""), "base64");
      if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64
        || !cryptoVerify(null, payload, publicKey, signature)) {
        failures.push("BACKUP_MANIFEST_SIGNATURE_INVALID");
      } else {
        signerFingerprint = sha256(publicKey.export({ format:"der", type:"spki" }));
      }
    } catch {
      failures.push("BACKUP_MANIFEST_PUBLIC_KEY_INVALID");
    }
  }
  return {
    ok:failures.length === 0,
    failures,
    signer:failures.length ? null : {
      signer_id:attestation.signer_id,
      authority_role:BACKUP_MANIFEST_AUTHORITY,
      public_key_spki_sha256:signerFingerprint,
      signed_at:attestation.signed_at,
      signed_payload_sha256:payloadSha
    }
  };
}

export function validateBackupStorageAttestationStructure(attestation = {}) {
  const document = objectValue(attestation);
  const failures = [];
  if (document.schema_version !== BACKUP_STORAGE_ATTESTATION_SCHEMA) failures.push("BACKUP_STORAGE_ATTESTATION_SCHEMA_INVALID");
  if (document.evidence_kind !== BACKUP_STORAGE_ATTESTATION_KIND) failures.push("BACKUP_STORAGE_ATTESTATION_KIND_INVALID");
  if (!safeReference(document.backup_id)) failures.push("BACKUP_STORAGE_ATTESTATION_BACKUP_ID_INVALID");
  if (!safeReference(document.object_version_id)) failures.push("BACKUP_STORAGE_ATTESTATION_OBJECT_VERSION_INVALID");
  if (!validSha256(document.sha256)) failures.push("BACKUP_STORAGE_ATTESTATION_SHA256_INVALID");
  if (!Number.isSafeInteger(document.size_bytes) || document.size_bytes <= 0) failures.push("BACKUP_STORAGE_ATTESTATION_SIZE_INVALID");
  if (!validTimestamp(document.observed_at)) failures.push("BACKUP_STORAGE_ATTESTATION_OBSERVED_AT_INVALID");
  if (!/^[a-z][a-z0-9._-]{1,63}$/i.test(String(document.provider || ""))) failures.push("BACKUP_STORAGE_ATTESTATION_PROVIDER_INVALID");
  if (document.request_id !== undefined && !safeReference(document.request_id)) failures.push("BACKUP_STORAGE_ATTESTATION_REQUEST_ID_INVALID");
  if (document.object_locator_sha256 !== undefined && !validSha256(document.object_locator_sha256)) {
    failures.push("BACKUP_STORAGE_ATTESTATION_OBJECT_LOCATOR_SHA256_INVALID");
  }
  return { ok:failures.length === 0, failures };
}

export function signBackupStorageAttestation(attestation, options = {}) {
  const structure = validateBackupStorageAttestationStructure(attestation);
  if (!structure.ok) {
    throw evidenceError("BACKUP_STORAGE_ATTESTATION_INVALID", "Backup storage attestation is invalid", { failures:structure.failures });
  }
  const signerId = String(options.signerId || "").trim();
  if (!safeReference(signerId)) throw evidenceError("BACKUP_STORAGE_ATTESTATION_SIGNER_ID_INVALID");
  let privateKey;
  try { privateKey = options.privateKey?.type === "private" ? options.privateKey : createPrivateKey(options.privateKey); }
  catch { throw evidenceError("BACKUP_STORAGE_ATTESTATION_PRIVATE_KEY_INVALID"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw evidenceError("BACKUP_STORAGE_ATTESTATION_ED25519_KEY_REQUIRED");
  const signedAt = options.signedAt || new Date().toISOString();
  if (!validTimestamp(signedAt)) throw evidenceError("BACKUP_STORAGE_ATTESTATION_SIGNED_AT_INVALID");
  if (Date.parse(signedAt) < Date.parse(attestation.observed_at)) {
    throw evidenceError("BACKUP_STORAGE_ATTESTATION_SIGNED_BEFORE_OBSERVATION");
  }
  const protectedFields = { signer_id:signerId, signed_at:signedAt };
  const payload = storageAttestationPayload(attestation, protectedFields);
  return {
    ...unsignedStorageAttestation(attestation),
    execution_attestation:{
      schema_version:BACKUP_STORAGE_ATTESTATION_SIGNATURE_SCHEMA,
      evidence_kind:BACKUP_STORAGE_ATTESTATION_KIND,
      signer_id:signerId,
      signature_algorithm:"ed25519",
      signed_payload_sha256:sha256(payload),
      signed_at:signedAt,
      signature_base64:cryptoSign(null, payload, privateKey).toString("base64")
    }
  };
}

export function verifyBackupStorageAttestation(attestation, options = {}) {
  const failures = [...validateBackupStorageAttestationStructure(attestation).failures];
  const signature = objectValue(attestation.execution_attestation);
  if (signature.schema_version !== BACKUP_STORAGE_ATTESTATION_SIGNATURE_SCHEMA) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_SCHEMA_INVALID");
  if (signature.evidence_kind !== BACKUP_STORAGE_ATTESTATION_KIND) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_KIND_INVALID");
  if (signature.signature_algorithm !== "ed25519") failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_ALGORITHM_INVALID");
  if (!safeReference(signature.signer_id)) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_SIGNER_INVALID");
  if (!validTimestamp(signature.signed_at)) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_TIMESTAMP_INVALID");
  if (validTimestamp(signature.signed_at) && validTimestamp(attestation.observed_at)
    && Date.parse(signature.signed_at) < Date.parse(attestation.observed_at)) {
    failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_BEFORE_OBSERVATION");
  }
  const registry = parseTrustedSignerRegistry(options.trustedSigners);
  const trusted = objectValue(registry[signature.signer_id]);
  if (!Object.keys(trusted).length) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNER_UNTRUSTED");
  if (trusted.authority_role !== BACKUP_STORAGE_ATTESTATION_AUTHORITY) failures.push("BACKUP_STORAGE_ATTESTATION_SIGNER_AUTHORITY_INVALID");
  if (!uniqueStrings(trusted.allowed_kinds).includes(BACKUP_STORAGE_ATTESTATION_KIND)) {
    failures.push("BACKUP_STORAGE_ATTESTATION_KIND_NOT_ALLOWED");
  }
  const payload = storageAttestationPayload(attestation, signature);
  const payloadSha = sha256(payload);
  if (signature.signed_payload_sha256 !== payloadSha) failures.push("BACKUP_STORAGE_ATTESTATION_PAYLOAD_SHA256_MISMATCH");
  let signerFingerprint = null;
  if (!failures.length) {
    try {
      const publicKey = createPublicKey({
        key:Buffer.from(String(trusted.public_key_spki_der_base64 || ""), "base64"),
        format:"der",
        type:"spki"
      });
      const signatureBytes = Buffer.from(String(signature.signature_base64 || ""), "base64");
      if (publicKey.asymmetricKeyType !== "ed25519" || signatureBytes.length !== 64
        || !cryptoVerify(null, payload, publicKey, signatureBytes)) {
        failures.push("BACKUP_STORAGE_ATTESTATION_SIGNATURE_INVALID");
      } else {
        signerFingerprint = sha256(publicKey.export({ format:"der", type:"spki" }));
      }
    } catch {
      failures.push("BACKUP_STORAGE_ATTESTATION_PUBLIC_KEY_INVALID");
    }
  }
  return {
    ok:failures.length === 0,
    failures,
    signer:failures.length ? null : {
      signer_id:signature.signer_id,
      authority_role:BACKUP_STORAGE_ATTESTATION_AUTHORITY,
      public_key_spki_sha256:signerFingerprint,
      signed_at:signature.signed_at,
      signed_payload_sha256:payloadSha
    }
  };
}

const sameFileIdentity = (left, right) => left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs;

export async function hashLocalBackupArtifact(path, options = {}) {
  if (!isAbsolute(path)) throw evidenceError("RESTORE_BACKUP_ARTIFACT_ABSOLUTE_PATH_REQUIRED");
  let handle;
  try {
    handle = await (options.openFileImpl || openFile)(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_UNREADABLE");
  }
  try {
    const before = await handle.stat({ bigint:true });
    if (!before.isFile()) throw evidenceError("RESTORE_BACKUP_ARTIFACT_REGULAR_FILE_REQUIRED");
    if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw evidenceError("RESTORE_BACKUP_ARTIFACT_SIZE_INVALID");
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose:false, start:0 });
    for await (const chunk of stream) digest.update(chunk);
    const after = await handle.stat({ bigint:true });
    if (!sameFileIdentity(before, after)) throw evidenceError("RESTORE_BACKUP_ARTIFACT_CHANGED_DURING_HASH");
    return { sha256:digest.digest("hex"), size_bytes:Number(before.size) };
  } finally {
    try { await handle.close(); } catch {}
  }
}

export async function verifyBackupArtifactForRestore(manifest, manifestVerification, env = process.env, options = {}) {
  const mode = String(env.HUAMEI_RESTORE_ARTIFACT_VERIFICATION_MODE || "").trim();
  const localPath = String(env.HUAMEI_RESTORE_BACKUP_ARTIFACT_PATH || "").trim();
  const attestationPath = String(env.HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_PATH || "").trim();
  const attestationSha = String(env.HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256 || "").trim().toLowerCase();
  const attestationSigners = String(env.HUAMEI_RESTORE_BACKUP_ARTIFACT_TRUSTED_SIGNERS_B64 || "").trim();
  if (!new Set(["local_file", "signed_storage_attestation"]).has(mode)) {
    throw evidenceError("RESTORE_ARTIFACT_VERIFICATION_MODE_REQUIRED");
  }
  if (mode === "local_file") {
    if (attestationPath || attestationSha || attestationSigners) {
      throw evidenceError("RESTORE_ARTIFACT_VERIFICATION_MODES_CONFLICT");
    }
    const actual = await hashLocalBackupArtifact(localPath, { openFileImpl:options.openFileImpl });
    if (actual.sha256 !== String(manifest.artifact.sha256).toLowerCase()) {
      throw evidenceError("RESTORE_BACKUP_ARTIFACT_SHA256_MISMATCH");
    }
    if (actual.size_bytes !== manifest.artifact.size_bytes) {
      throw evidenceError("RESTORE_BACKUP_ARTIFACT_SIZE_MISMATCH");
    }
    return { mode, ...actual };
  }
  if (localPath) throw evidenceError("RESTORE_ARTIFACT_VERIFICATION_MODES_CONFLICT");
  if (!isAbsolute(attestationPath)) throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_ABSOLUTE_PATH_REQUIRED");
  const evidence = await readJsonWithSha({
    path:attestationPath,
    expectedSha:attestationSha,
    label:"RESTORE_BACKUP_ARTIFACT_ATTESTATION",
    maximumBytes:1024 * 1024,
    readFileImpl:options.artifactReadFileImpl
  });
  const verification = verifyBackupStorageAttestation(evidence.document, {
    trustedSigners:parseTrustedSignerRegistry(attestationSigners)
  });
  if (!verification.ok) {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_INVALID", "Backup artifact attestation verification failed", {
      failures:verification.failures
    });
  }
  const document = evidence.document;
  if (document.backup_id !== manifest.backup_id) throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_BACKUP_ID_MISMATCH");
  if (document.object_version_id !== manifest.artifact.object_version_id) {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_OBJECT_VERSION_MISMATCH");
  }
  if (String(document.sha256).toLowerCase() !== String(manifest.artifact.sha256).toLowerCase()) {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256_MISMATCH");
  }
  if (document.size_bytes !== manifest.artifact.size_bytes) throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_SIZE_MISMATCH");
  if (Date.parse(document.observed_at) < Date.parse(manifest.backup_completed_at)) {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_BEFORE_BACKUP_COMPLETION");
  }
  const manifestSigner = manifestVerification?.signer || {};
  if (verification.signer.signer_id === manifestSigner.signer_id
    || verification.signer.public_key_spki_sha256 === manifestSigner.public_key_spki_sha256) {
    throw evidenceError("RESTORE_BACKUP_ARTIFACT_ATTESTATION_SIGNER_NOT_INDEPENDENT");
  }
  return {
    mode,
    sha256:String(document.sha256).toLowerCase(),
    size_bytes:document.size_bytes,
    object_version_id:document.object_version_id,
    provider:document.provider,
    attestation_file_sha256:evidence.sha256,
    signer:verification.signer
  };
}

export async function loadBackupManifestForRestore(env = process.env, options = {}) {
  const path = String(env.HUAMEI_RESTORE_BACKUP_MANIFEST_PATH || "").trim();
  const expectedSha = String(env.HUAMEI_RESTORE_BACKUP_MANIFEST_SHA256 || "").trim().toLowerCase();
  if (!isAbsolute(path)) throw evidenceError("RESTORE_BACKUP_MANIFEST_ABSOLUTE_PATH_REQUIRED");
  const evidence = await readJsonWithSha({
    path,
    expectedSha,
    label:"RESTORE_BACKUP_MANIFEST",
    maximumBytes:2 * 1024 * 1024,
    readFileImpl:options.readFileImpl
  });
  const verification = verifyBackupManifest(evidence.document, {
    trustedSigners:parseTrustedSignerRegistry(env.HUAMEI_RESTORE_BACKUP_TRUSTED_SIGNERS_B64)
  });
  if (!verification.ok) throw evidenceError("RESTORE_BACKUP_MANIFEST_INVALID", "Backup manifest verification failed", { failures:verification.failures });
  const expectedBackupId = String(env.HUAMEI_RESTORE_EXPECTED_BACKUP_ID || "").trim();
  if (!safeReference(expectedBackupId)) throw evidenceError("RESTORE_EXPECTED_BACKUP_ID_REQUIRED");
  if (evidence.document.backup_id !== expectedBackupId) throw evidenceError("RESTORE_BACKUP_ID_MISMATCH");
  const requiredPoint = Date.parse(String(env.HUAMEI_RESTORE_REQUIRED_POINT_IN_TIME || ""));
  const maximumRpoSeconds = Number(env.HUAMEI_RESTORE_MAX_RPO_SECONDS);
  if (!Number.isFinite(requiredPoint)) throw evidenceError("RESTORE_REQUIRED_POINT_IN_TIME_INVALID");
  if (!Number.isSafeInteger(maximumRpoSeconds) || maximumRpoSeconds <= 0 || maximumRpoSeconds > 604_800) {
    throw evidenceError("RESTORE_MAX_RPO_SECONDS_INVALID");
  }
  const restorePoint = Date.parse(evidence.document.restore_point);
  if (restorePoint > requiredPoint) throw evidenceError("RESTORE_POINT_AFTER_REQUIRED_POINT");
  const rpoSeconds = Math.ceil((requiredPoint - restorePoint) / 1000);
  if (rpoSeconds > maximumRpoSeconds) {
    throw evidenceError("RESTORE_RPO_EXCEEDED", "Restored point exceeds approved RPO", { rpo_seconds:rpoSeconds, maximum_rpo_seconds:maximumRpoSeconds });
  }
  const artifact = await verifyBackupArtifactForRestore(evidence.document, verification, env, options);
  return {
    manifest:evidence.document,
    file:evidence,
    verification,
    artifact,
    rpo_seconds:rpoSeconds,
    maximum_rpo_seconds:maximumRpoSeconds
  };
}

export function validateRestoredSnapshotAgainstManifest(manifest, snapshot = {}) {
  const failures = [];
  const expectedCounts = objectValue(manifest.critical_table_counts);
  const actualCounts = objectValue(snapshot.counts);
  for (const table of RESTORE_CRITICAL_TABLES) {
    const expected = expectedCounts[table];
    const actual = actualCounts[table];
    if (!Number.isSafeInteger(actual) || actual < 0) failures.push({ code:"RESTORE_TABLE_COUNT_UNAVAILABLE", table });
    else if (actual < expected) failures.push({ code:"RESTORE_TABLE_ROWS_MISSING", table, expected, actual });
    else if (actual > expected) failures.push({ code:"RESTORE_TABLE_COUNT_EXCEEDS_MANIFEST", table, expected, actual });
  }
  const actualTotal = RESTORE_CRITICAL_TABLES.reduce((total, table) => total + (Number.isSafeInteger(actualCounts[table]) ? actualCounts[table] : 0), 0);
  if (actualTotal <= 0 || !(actualCounts.tenants > 0) || !(actualCounts.knowledge_releases > 0) || !(actualCounts.audit_events > 0)) {
    failures.push({ code:"RESTORE_EMPTY_DATASET" });
  }

  const expectedReleases = [...manifest.active_knowledge_releases].map(normalizeActiveRelease)
    .sort((left, right) => activeReleaseKey(left).localeCompare(activeReleaseKey(right), "en"));
  const actualReleases = (Array.isArray(snapshot.active_knowledge_releases) ? snapshot.active_knowledge_releases : [])
    .map(normalizeActiveRelease)
    .sort((left, right) => activeReleaseKey(left).localeCompare(activeReleaseKey(right), "en"));
  if (JSON.stringify(actualReleases) !== JSON.stringify(expectedReleases)) {
    failures.push({ code:"RESTORE_ACTIVE_KNOWLEDGE_RELEASE_MISMATCH", expected:expectedReleases.length, actual:actualReleases.length });
  }

  const actualAnchorMap = new Map((Array.isArray(snapshot.audit_anchors) ? snapshot.audit_anchors : [])
    .filter((item) => item && validTimestamp(item.occurred_at))
    .map((item) => [`${item.tenant_id}\n${item.event_id}`, normalizeAuditAnchor(item)]));
  for (const expected of manifest.audit_anchors.map(normalizeAuditAnchor)) {
    const actual = actualAnchorMap.get(`${expected.tenant_id}\n${expected.event_id}`);
    if (!actual) failures.push({ code:"RESTORE_AUDIT_ANCHOR_MISSING", tenant_id:expected.tenant_id, event_id:expected.event_id });
    else if (actual.occurred_at !== expected.occurred_at) {
      failures.push({ code:"RESTORE_AUDIT_ANCHOR_TIMESTAMP_MISMATCH", tenant_id:expected.tenant_id, event_id:expected.event_id });
    }
  }
  return { ok:failures.length === 0, failures, actual_total_rows:actualTotal };
}

export async function signBackupManifestFromEnv(manifest, env = process.env) {
  const signerId = String(env.HUAMEI_BACKUP_MANIFEST_SIGNER_ID || "").trim();
  const keyPath = String(env.HUAMEI_BACKUP_MANIFEST_SIGNING_KEY_PATH || "").trim();
  if (!isAbsolute(keyPath)) throw evidenceError("HUAMEI_BACKUP_MANIFEST_SIGNING_KEY_PATH_REQUIRED");
  let keyBytes;
  try { keyBytes = await readFile(keyPath); }
  catch { throw evidenceError("HUAMEI_BACKUP_MANIFEST_SIGNING_KEY_UNREADABLE"); }
  if (!keyBytes.length || keyBytes.length > 32 * 1024) throw evidenceError("HUAMEI_BACKUP_MANIFEST_SIGNING_KEY_SIZE_INVALID");
  return signBackupManifest(manifest, { signerId, privateKey:keyBytes });
}
