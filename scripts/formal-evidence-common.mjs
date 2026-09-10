import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,191}$/;
export const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/i;
export const FORMAL_EVIDENCE_ATTESTATION_SCHEMA = "huamei.formal-evidence-attestation.v1";
export const FORMAL_EVIDENCE_AUTHORITY_BY_KIND = Object.freeze({
  blind_dataset:"quality_custodian",
  evaluation_raw:"qa_execution",
  evaluation_scorecard:"review_board",
  evaluation_report:"formal_evidence_issuer",
  capacity_raw:"load_runner",
  capacity_observability_attestation:"sre_observability",
  capacity_report:"formal_evidence_issuer"
});

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const validSha256 = (value) => SHA256_PATTERN.test(String(value || "").trim().toLowerCase());
export const safeReference = (value) => SAFE_REFERENCE_PATTERN.test(String(value || "").trim());
export const validTimestamp = (value) => Number.isFinite(Date.parse(String(value || "")));
export const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const uniqueStrings = (value) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
  : [];
export const ratio = (numerator, denominator) => denominator > 0
  ? Number((Number(numerator) / Number(denominator)).toFixed(6))
  : 0;

const canonicalJsonValue = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonValue(item)}`).join(",")}}`;
};

export const canonicalJsonBytes = (value) => Buffer.from(canonicalJsonValue(value), "utf8");

const unsignedEvidenceDocument = (document) => {
  const copy = structuredClone(objectValue(document));
  delete copy.execution_attestation;
  return copy;
};

const attestationPayloadBytes = (document, attestation) => canonicalJsonBytes({
  schema_version:FORMAL_EVIDENCE_ATTESTATION_SCHEMA,
  evidence_kind:String(attestation.evidence_kind || ""),
  signer_id:String(attestation.signer_id || ""),
  signature_algorithm:"ed25519",
  signed_at:String(attestation.signed_at || ""),
  document:unsignedEvidenceDocument(document)
});

export function parseTrustedSignerRegistry(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const encoded = String(value || "").trim();
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return objectValue(parsed);
  } catch {
    return {};
  }
}

export const trustedSignerRegistryFromEnv = (env = process.env) => parseTrustedSignerRegistry(
  env.HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64
);

const signerPublicKey = (record = {}) => {
  const encoded = String(record.public_key_spki_der_base64 || "").trim();
  if (!encoded) throw evidenceError("FORMAL_EVIDENCE_SIGNER_PUBLIC_KEY_MISSING");
  return createPublicKey({ key:Buffer.from(encoded, "base64"), format:"der", type:"spki" });
};

const signerPublicKeyIdentity = (record = {}) => {
  const publicKey = signerPublicKey(record);
  const spkiDer = publicKey.export({ format:"der", type:"spki" });
  return { publicKey, publicKeySpkiSha256:sha256(spkiDer) };
};

export function signEvidenceDocument(document, options = {}) {
  const evidenceKind = String(options.evidenceKind || "").trim();
  const signerId = String(options.signerId || "").trim();
  if (!FORMAL_EVIDENCE_AUTHORITY_BY_KIND[evidenceKind]) throw evidenceError("FORMAL_EVIDENCE_KIND_INVALID");
  if (!safeReference(signerId)) throw evidenceError("FORMAL_EVIDENCE_SIGNER_ID_INVALID");
  let privateKey;
  try {
    privateKey = options.privateKey?.type === "private"
      ? options.privateKey
      : createPrivateKey(options.privateKey);
  }
  catch { throw evidenceError("FORMAL_EVIDENCE_PRIVATE_KEY_INVALID"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw evidenceError("FORMAL_EVIDENCE_ED25519_KEY_REQUIRED");
  const unsigned = unsignedEvidenceDocument(document);
  const signedAt = options.signedAt || new Date().toISOString();
  if (!validTimestamp(signedAt)) throw evidenceError("FORMAL_EVIDENCE_SIGNED_AT_INVALID");
  const protectedFields = { evidence_kind:evidenceKind, signer_id:signerId, signed_at:signedAt };
  const payload = attestationPayloadBytes(unsigned, protectedFields);
  const signature = cryptoSign(null, payload, privateKey);
  return {
    ...unsigned,
    execution_attestation:{
      schema_version:FORMAL_EVIDENCE_ATTESTATION_SCHEMA,
      evidence_kind:evidenceKind,
      signer_id:signerId,
      signature_algorithm:"ed25519",
      signed_payload_sha256:sha256(payload),
      signed_at:signedAt,
      signature_base64:signature.toString("base64")
    }
  };
}

export function verifyEvidenceDocumentAttestation(document, options = {}) {
  const evidenceKind = String(options.evidenceKind || "").trim();
  const failures = [];
  const attestation = objectValue(document?.execution_attestation);
  if (attestation.schema_version !== FORMAL_EVIDENCE_ATTESTATION_SCHEMA) failures.push("EVIDENCE_ATTESTATION_SCHEMA_INVALID");
  if (attestation.evidence_kind !== evidenceKind) failures.push("EVIDENCE_ATTESTATION_KIND_MISMATCH");
  if (attestation.signature_algorithm !== "ed25519") failures.push("EVIDENCE_ATTESTATION_ALGORITHM_INVALID");
  if (!safeReference(attestation.signer_id)) failures.push("EVIDENCE_ATTESTATION_SIGNER_INVALID");
  if (!validTimestamp(attestation.signed_at)) failures.push("EVIDENCE_ATTESTATION_TIMESTAMP_INVALID");
  const registry = parseTrustedSignerRegistry(options.trustedSigners);
  const trusted = objectValue(registry[attestation.signer_id]);
  const expectedAuthority = FORMAL_EVIDENCE_AUTHORITY_BY_KIND[evidenceKind];
  const allowedKinds = uniqueStrings(trusted.allowed_kinds);
  if (!Object.keys(trusted).length) failures.push("EVIDENCE_ATTESTATION_SIGNER_UNTRUSTED");
  if (trusted.authority_role !== expectedAuthority) failures.push("EVIDENCE_ATTESTATION_AUTHORITY_INVALID");
  if (!allowedKinds.includes(evidenceKind)) failures.push("EVIDENCE_ATTESTATION_KIND_NOT_ALLOWED");
  const payload = attestationPayloadBytes(document, attestation);
  const payloadSha = sha256(payload);
  if (attestation.signed_payload_sha256 !== payloadSha) failures.push("EVIDENCE_ATTESTATION_PAYLOAD_SHA_MISMATCH");
  let signature;
  let verifiedPublicKeySpkiSha256 = null;
  try { signature = Buffer.from(String(attestation.signature_base64 || ""), "base64"); }
  catch { signature = Buffer.alloc(0); }
  if (signature.length !== 64) failures.push("EVIDENCE_ATTESTATION_SIGNATURE_INVALID");
  if (!failures.length) {
    try {
      const { publicKey, publicKeySpkiSha256 } = signerPublicKeyIdentity(trusted);
      if (publicKey.asymmetricKeyType !== "ed25519" || !cryptoVerify(null, payload, publicKey, signature)) {
        failures.push("EVIDENCE_ATTESTATION_SIGNATURE_INVALID");
      } else {
        verifiedPublicKeySpkiSha256 = publicKeySpkiSha256;
      }
    } catch {
      failures.push("EVIDENCE_ATTESTATION_PUBLIC_KEY_INVALID");
    }
  }
  return {
    ok:failures.length === 0,
    failures,
    signer:failures.length ? null : {
      signer_id:attestation.signer_id,
      evidence_kind:evidenceKind,
      authority_role:trusted.authority_role,
      public_key_spki_sha256:verifiedPublicKeySpkiSha256,
      signed_payload_sha256:payloadSha,
      signed_at:attestation.signed_at
    }
  };
}

export async function signEvidenceDocumentFromEnv(document, options = {}) {
  const env = options.env || process.env;
  const prefix = String(options.prefix || "").trim();
  const signerId = String(env[`${prefix}_SIGNER_ID`] || "").trim();
  const keyPath = String(env[`${prefix}_SIGNING_KEY_PATH`] || "").trim();
  if (!isAbsolute(keyPath)) throw evidenceError(`${prefix}_SIGNING_KEY_PATH_REQUIRED`);
  let keyBytes;
  try { keyBytes = await readFile(keyPath); }
  catch { throw evidenceError(`${prefix}_SIGNING_KEY_UNREADABLE`); }
  if (!keyBytes.length || keyBytes.length > 32 * 1024) throw evidenceError(`${prefix}_SIGNING_KEY_SIZE_INVALID`);
  return signEvidenceDocument(document, {
    signerId,
    privateKey:keyBytes,
    evidenceKind:options.evidenceKind,
    signedAt:options.signedAt
  });
}

export const evidenceError = (code, message = code, details = {}) => {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
};

export const parseCliOptions = (arguments_ = process.argv.slice(2)) => Object.fromEntries(arguments_.map((argument) => {
  const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
  if (!match) throw evidenceError("FORMAL_EVIDENCE_ARGUMENT_INVALID", `Invalid argument: ${argument}`);
  return [match[1], match[2] ?? true];
}));

export async function readJsonWithSha(options = {}) {
  const path = String(options.path || "").trim();
  const expectedSha = String(options.expectedSha || "").trim().toLowerCase();
  const label = String(options.label || "EVIDENCE").replace(/[^A-Z0-9_]/gi, "_").toUpperCase();
  if (!isAbsolute(path)) throw evidenceError(`${label}_ABSOLUTE_PATH_REQUIRED`, `${label} path must be absolute`);
  if (!validSha256(expectedSha)) throw evidenceError(`${label}_SHA256_REQUIRED`, `${label} SHA-256 is required`);
  const read = options.readFileImpl || readFile;
  let bytes;
  try { bytes = await read(path); }
  catch { throw evidenceError(`${label}_UNREADABLE`, `${label} cannot be read`); }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const maximumBytes = Number(options.maximumBytes || 20 * 1024 * 1024);
  if (buffer.length <= 0 || buffer.length > maximumBytes) {
    throw evidenceError(`${label}_SIZE_INVALID`, `${label} size is invalid`, { size_bytes:buffer.length });
  }
  const actualSha = sha256(buffer);
  if (actualSha !== expectedSha) {
    throw evidenceError(`${label}_SHA256_MISMATCH`, `${label} SHA-256 mismatch`, { expected:expectedSha, actual:actualSha });
  }
  let document;
  try { document = JSON.parse(buffer.toString("utf8")); }
  catch { throw evidenceError(`${label}_JSON_INVALID`, `${label} is not valid JSON`); }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw evidenceError(`${label}_OBJECT_REQUIRED`, `${label} must be a JSON object`);
  }
  return { path, sha256:actualSha, bytes:buffer.length, document };
}

export async function writeJsonAtomic(path, document, options = {}) {
  if (!isAbsolute(String(path || ""))) throw evidenceError("OUTPUT_ABSOLUTE_PATH_REQUIRED", "Output path must be absolute");
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive:true });
  await writeFile(temporary, rendered, { encoding:"utf8", mode:options.mode || 0o600 });
  await rename(temporary, path);
  return { path, sha256:sha256(Buffer.from(rendered)), bytes:Buffer.byteLength(rendered) };
}

export function validateImmutableBinding(binding = {}) {
  const failures = [];
  if (!safeReference(binding.releaseId)) failures.push("RELEASE_ID_INVALID");
  if (!safeReference(binding.knowledgeReleaseId)) failures.push("KNOWLEDGE_RELEASE_ID_INVALID");
  if (!safeReference(binding.indexVersion)) failures.push("INDEX_VERSION_INVALID");
  if (!validSha256(binding.knowledgeManifestSha256)) failures.push("KNOWLEDGE_MANIFEST_SHA256_INVALID");
  if (!IMMUTABLE_IMAGE_PATTERN.test(String(binding.applicationImage || ""))) failures.push("APPLICATION_IMAGE_NOT_IMMUTABLE");
  if (!IMMUTABLE_IMAGE_PATTERN.test(String(binding.graphRagImage || ""))) failures.push("GRAPHRAG_IMAGE_NOT_IMMUTABLE");
  if (!safeReference(binding.llmProvider)) failures.push("LLM_PROVIDER_INVALID");
  if (!safeReference(binding.llmModel)) failures.push("LLM_MODEL_INVALID");
  return failures;
}

export const mainModule = (importMetaUrl) => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(importMetaUrl) === resolve(process.argv[1]); }
  catch { return false; }
};
