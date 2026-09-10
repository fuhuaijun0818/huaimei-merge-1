import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FIELD_ENCRYPTION_KEYRING_ENV = "HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON";

const LEGACY_ENVELOPE_MARKER = "huamei.field.a256gcm.v1";
const ENVELOPE_MARKER = "huamei.field.a256gcm.v2";
const LEGACY_AAD_SCHEME = "delimiter-v1";
const AAD_SCHEME = "named-fields-v1";
const ALGORITHM = "A256GCM";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const productionEnvironment = (env) => ["prod", "production"].includes(String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase());
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function createFieldRecordId(recordType, fields = {}) {
  const normalizedType = String(recordType || "").trim();
  if (!normalizedType || !fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw encryptionError("FIELD_ENCRYPTION_RECORD_ID_INVALID", "Field encryption record identity requires a type and named fields");
  }
  const entries = Object.entries(fields)
    .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length || entries.some(([key, value]) => !key || !value)) {
    throw encryptionError("FIELD_ENCRYPTION_RECORD_ID_INVALID", "Field encryption record identity fields must be non-empty");
  }
  return JSON.stringify({
    schema:"huamei.field.record-id.v1",
    record_type:normalizedType,
    fields:Object.fromEntries(entries)
  });
}

const encryptionError = (code, message, cause = null) => {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

const decodeKey = (encoded, keyId) => {
  const value = String(encoded || "").trim();
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw encryptionError("FIELD_ENCRYPTION_KEY_INVALID", `Encryption key ${keyId} must be standard base64`);
  }
  const key = Buffer.from(value, "base64");
  const canonicalInput = value.replace(/=+$/u, "");
  const canonicalDecoded = key.toString("base64").replace(/=+$/u, "");
  if (canonicalInput !== canonicalDecoded || key.length !== 32 || new Set(key).size < 16) {
    throw encryptionError("FIELD_ENCRYPTION_KEY_INVALID", `Encryption key ${keyId} must decode to one strong 32-byte value`);
  }
  return key;
};

const parseKeyring = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let document;
  try {
    document = JSON.parse(raw);
  } catch (cause) {
    throw encryptionError("FIELD_ENCRYPTION_KEYRING_JSON_INVALID", "Field encryption keyring must be valid JSON", cause);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw encryptionError("FIELD_ENCRYPTION_KEYRING_INVALID", "Field encryption keyring must be a JSON object");
  }
  const activeKeyId = String(document.active_key_id || "").trim();
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw encryptionError("FIELD_ENCRYPTION_ACTIVE_KEY_INVALID", "Field encryption active_key_id is missing or invalid");
  }
  const definitions = document.keys;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    throw encryptionError("FIELD_ENCRYPTION_KEYS_INVALID", "Field encryption keys must be an object keyed by version id");
  }
  const entries = Object.entries(definitions);
  if (!entries.length || entries.length > 16) {
    throw encryptionError("FIELD_ENCRYPTION_KEYS_INVALID", "Field encryption keyring must contain 1-16 keys");
  }
  const keys = new Map();
  const fingerprints = new Set();
  for (const [keyId, encoded] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw encryptionError("FIELD_ENCRYPTION_KEY_ID_INVALID", "Field encryption key ids must contain only safe version characters");
    }
    const key = decodeKey(encoded, keyId);
    const fingerprint = key.toString("hex");
    if (fingerprints.has(fingerprint)) {
      throw encryptionError("FIELD_ENCRYPTION_KEY_REUSED", "Each field encryption key version must use independent key material");
    }
    fingerprints.add(fingerprint);
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw encryptionError("FIELD_ENCRYPTION_ACTIVE_KEY_MISSING", "Field encryption active_key_id must exist in keys");
  }
  return { activeKeyId, keys };
};

export function validateFieldEncryptionKeyring(value = "") {
  const configured = Boolean(String(value || "").trim());
  if (!configured) return { configured:false, valid:false, active_key_id:null, key_ids:[], errors:[] };
  try {
    const parsed = parseKeyring(value);
    return {
      configured:true,
      valid:true,
      active_key_id:parsed.activeKeyId,
      key_ids:[...parsed.keys.keys()],
      errors:[]
    };
  } catch (error) {
    return {
      configured:true,
      valid:false,
      active_key_id:null,
      key_ids:[],
      errors:[{ code:error.code || "FIELD_ENCRYPTION_KEYRING_INVALID", message:error.message }]
    };
  }
}

export const isFieldEncryptionEnvelope = (value) => Boolean(
  value && typeof value === "object" && !Array.isArray(value)
    && [LEGACY_ENVELOPE_MARKER, ENVELOPE_MARKER].includes(value._encrypted)
);

const envelopeFrom = (value) => {
  if (isFieldEncryptionEnvelope(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isFieldEncryptionEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const envelopeScheme = (envelope) => {
  if (envelope?._encrypted === LEGACY_ENVELOPE_MARKER
    && envelope?.version === 1
    && !envelope?.aad_identity_scheme) return LEGACY_AAD_SCHEME;
  if (envelope?._encrypted === ENVELOPE_MARKER
    && envelope?.version === 2
    && envelope?.aad_identity_scheme === AAD_SCHEME) return AAD_SCHEME;
  return null;
};

export function getFieldEncryptionEnvelopeMetadata(value) {
  const envelope = envelopeFrom(value);
  if (!envelope) return null;
  const aadIdentityScheme = envelopeScheme(envelope);
  return {
    version:Number(envelope.version || 0),
    key_id:String(envelope.key_id || ""),
    kind:String(envelope.kind || ""),
    aad_identity_scheme:aadIdentityScheme,
    current:aadIdentityScheme === AAD_SCHEME
  };
}

const normalizeContext = ({ tenantId, scope, recordId, legacyRecordId } = {}, aadIdentityScheme = AAD_SCHEME) => {
  const currentRecordId = String(recordId || "").trim();
  const explicitLegacyRecordId = String(legacyRecordId || "").trim();
  if (aadIdentityScheme === LEGACY_AAD_SCHEME && !explicitLegacyRecordId && currentRecordId.includes("huamei.field.record-id.v1")) {
    throw encryptionError(
      "FIELD_ENCRYPTION_LEGACY_AAD_REQUIRED",
      "Legacy encrypted fields require their original delimiter-based record identity during controlled migration"
    );
  }
  const normalized = {
    tenant_id:String(tenantId || "").trim(),
    scope:String(scope || "").trim(),
    record_id:aadIdentityScheme === LEGACY_AAD_SCHEME
      ? (explicitLegacyRecordId || currentRecordId)
      : currentRecordId
  };
  if (!normalized.tenant_id || !normalized.scope || !normalized.record_id) {
    throw encryptionError("FIELD_ENCRYPTION_AAD_REQUIRED", "Field encryption requires tenantId, scope and recordId AAD");
  }
  return normalized;
};

const aadFor = (context, kind, keyId, aadIdentityScheme = AAD_SCHEME) => Buffer.from(JSON.stringify(
  aadIdentityScheme === LEGACY_AAD_SCHEME
    ? {
        schema:"huamei.field.aad.v1",
        algorithm:ALGORITHM,
        key_id:keyId,
        kind,
        ...normalizeContext(context, aadIdentityScheme)
      }
    : {
        schema:"huamei.field.aad.v2",
        aad_identity_scheme:AAD_SCHEME,
        algorithm:ALGORITHM,
        key_id:keyId,
        kind,
        ...normalizeContext(context, aadIdentityScheme)
      }
), "utf8");

export function createFieldEncryption(options = {}) {
  const env = options.env || process.env;
  const production = options.production ?? productionEnvironment(env);
  const rawKeyring = options.keyringJson ?? env[FIELD_ENCRYPTION_KEYRING_ENV] ?? "";
  const keyring = parseKeyring(rawKeyring);
  if (!keyring && production) {
    throw encryptionError(
      "FIELD_ENCRYPTION_KEYRING_REQUIRED",
      `${FIELD_ENCRYPTION_KEYRING_ENV} is required in production`
    );
  }

  const encryptBytes = (plaintext, context, kind) => {
    if (!keyring) return null;
    const keyId = keyring.activeKeyId;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyring.keys.get(keyId), iv);
    cipher.setAAD(aadFor(context, kind, keyId, AAD_SCHEME));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      _encrypted:ENVELOPE_MARKER,
      version:2,
      aad_identity_scheme:AAD_SCHEME,
      algorithm:ALGORITHM,
      key_id:keyId,
      kind,
      iv:iv.toString("base64url"),
      tag:cipher.getAuthTag().toString("base64url"),
      ciphertext:ciphertext.toString("base64url")
    };
  };

  const decryptBytes = (envelope, context, expectedKind) => {
    const aadIdentityScheme = envelopeScheme(envelope);
    if (!isFieldEncryptionEnvelope(envelope)
      || !aadIdentityScheme
      || envelope.algorithm !== ALGORITHM
      || envelope.kind !== expectedKind) {
      throw encryptionError("FIELD_ENCRYPTION_ENVELOPE_INVALID", "Encrypted field envelope is invalid");
    }
    const keyId = String(envelope.key_id || "");
    const key = keyring?.keys.get(keyId);
    if (!key) {
      throw encryptionError("FIELD_ENCRYPTION_KEY_UNAVAILABLE", "Encrypted field key version is unavailable");
    }
    const aad = aadFor(context, expectedKind, keyId, aadIdentityScheme);
    try {
      const iv = Buffer.from(String(envelope.iv || ""), "base64url");
      const tag = Buffer.from(String(envelope.tag || ""), "base64url");
      const ciphertext = Buffer.from(String(envelope.ciphertext || ""), "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope lengths");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (cause) {
      throw encryptionError("FIELD_DECRYPTION_FAILED", "Encrypted field authentication failed", cause);
    }
  };

  const plaintextAllowed = (value) => {
    if (production) {
      throw encryptionError("FIELD_PLAINTEXT_FORBIDDEN", "Production refuses plaintext in an encrypted field");
    }
    return clone(value);
  };

  const encryptJson = (value, context) => {
    if (!keyring) return clone(value);
    let plaintext;
    try { plaintext = Buffer.from(JSON.stringify(value), "utf8"); }
    catch (cause) { throw encryptionError("FIELD_ENCRYPTION_JSON_INVALID", "Field value is not JSON serializable", cause); }
    return encryptBytes(plaintext, context, "json");
  };

  const decryptJson = (value, context) => {
    if (!isFieldEncryptionEnvelope(value)) return plaintextAllowed(value);
    const plaintext = decryptBytes(value, context, "json");
    try { return JSON.parse(plaintext.toString("utf8")); }
    catch (cause) { throw encryptionError("FIELD_DECRYPTION_JSON_INVALID", "Decrypted field is not valid JSON", cause); }
  };

  const encryptText = (value, context) => {
    const text = String(value ?? "");
    if (!keyring) return text;
    return JSON.stringify(encryptBytes(Buffer.from(text, "utf8"), context, "text"));
  };

  const decryptText = (value, context) => {
    if (value && typeof value === "object" && isFieldEncryptionEnvelope(value)) {
      return decryptBytes(value, context, "text").toString("utf8");
    }
    if (typeof value === "string") {
      let parsed = null;
      try { parsed = JSON.parse(value); } catch {}
      if (isFieldEncryptionEnvelope(parsed)) return decryptBytes(parsed, context, "text").toString("utf8");
    }
    return String(plaintextAllowed(value) ?? "");
  };

  return {
    enabled:Boolean(keyring),
    production,
    activeKeyId:keyring?.activeKeyId || null,
    keyIds:keyring ? [...keyring.keys.keys()] : [],
    encryptJson,
    decryptJson,
    encryptText,
    decryptText,
    needsRotation:(value) => {
      const envelope = envelopeFrom(value);
      return Boolean(envelope && (
        envelope.key_id !== keyring?.activeKeyId
        || envelopeScheme(envelope) !== AAD_SCHEME
      ));
    },
    rewrapJson:(value, context) => encryptJson(decryptJson(value, context), context),
    rewrapText:(value, context) => encryptText(decryptText(value, context), context)
  };
}
