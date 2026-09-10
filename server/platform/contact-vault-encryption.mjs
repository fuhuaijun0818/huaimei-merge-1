import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CONTACT_VAULT_KEYRING_ENV = "HUAMEI_CONTACT_VAULT_KEYRING_JSON";

const ENVELOPE_MARKER = "huamei.contact-vault.a256gcm.v1";
const AAD_SCHEMA = "huamei.contact-vault.aad.v1";
const ALGORITHM = "A256GCM";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const productionEnvironment = (env) => ["prod", "production"].includes(String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase());

const vaultError = (code, message, cause = null) => {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  if (cause) error.cause = cause;
  return error;
};

const decodeKey = (encoded, keyId) => {
  const value = String(encoded || "").trim();
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw vaultError("CONTACT_VAULT_KEY_INVALID", `Contact-vault key ${keyId} must be standard base64`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32
      || key.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
      || new Set(key).size < 16) {
    throw vaultError("CONTACT_VAULT_KEY_INVALID", `Contact-vault key ${keyId} must decode to one strong 32-byte value`);
  }
  return key;
};

const parseKeyring = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let document;
  try { document = JSON.parse(raw); }
  catch (cause) {
    throw vaultError("CONTACT_VAULT_KEYRING_JSON_INVALID", "Contact-vault keyring must be valid JSON", cause);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw vaultError("CONTACT_VAULT_KEYRING_INVALID", "Contact-vault keyring must be a JSON object");
  }
  const activeKeyId = String(document.active_key_id || "").trim();
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw vaultError("CONTACT_VAULT_ACTIVE_KEY_INVALID", "Contact-vault active_key_id is missing or invalid");
  }
  if (!document.keys || typeof document.keys !== "object" || Array.isArray(document.keys)) {
    throw vaultError("CONTACT_VAULT_KEYS_INVALID", "Contact-vault keys must be an object keyed by version id");
  }
  const definitions = Object.entries(document.keys);
  if (!definitions.length || definitions.length > 16) {
    throw vaultError("CONTACT_VAULT_KEYS_INVALID", "Contact-vault keyring must contain 1-16 keys");
  }
  const keys = new Map();
  const fingerprints = new Set();
  for (const [keyId, encoded] of definitions) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw vaultError("CONTACT_VAULT_KEY_ID_INVALID", "Contact-vault key ids must contain only safe version characters");
    }
    const key = decodeKey(encoded, keyId);
    const fingerprint = createHash("sha256").update(key).digest("hex");
    if (fingerprints.has(fingerprint)) {
      throw vaultError("CONTACT_VAULT_KEY_REUSED", "Each contact-vault key version must use independent key material");
    }
    fingerprints.add(fingerprint);
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw vaultError("CONTACT_VAULT_ACTIVE_KEY_MISSING", "Contact-vault active_key_id must exist in keys");
  }
  return { activeKeyId, keys, fingerprints };
};

const keyFingerprints = (value) => {
  if (!String(value || "").trim()) return new Set();
  try { return parseKeyring(value).fingerprints; }
  catch { return new Set(); }
};

export function validateContactVaultKeyring(value = "", options = {}) {
  const configured = Boolean(String(value || "").trim());
  if (!configured) return { configured:false, valid:false, active_key_id:null, key_ids:[], independent:false, errors:[] };
  try {
    const parsed = parseKeyring(value);
    const disallowed = new Set((options.disallowedKeyrings || [])
      .flatMap((item) => [...keyFingerprints(item)]));
    const overlap = [...parsed.fingerprints].some((fingerprint) => disallowed.has(fingerprint));
    if (overlap) {
      throw vaultError(
        "CONTACT_VAULT_KEY_DOMAIN_REUSE_FORBIDDEN",
        "Contact-vault key material must be independent from every general field-encryption key"
      );
    }
    return {
      configured:true,
      valid:true,
      active_key_id:parsed.activeKeyId,
      key_ids:[...parsed.keys.keys()],
      independent:true,
      errors:[]
    };
  } catch (error) {
    return {
      configured:true,
      valid:false,
      active_key_id:null,
      key_ids:[],
      independent:false,
      errors:[{ code:error.code || "CONTACT_VAULT_KEYRING_INVALID", message:error.message }]
    };
  }
}

const normalizeContext = ({ tenantId, contactReference, leadRecordId, subjectReferenceHmac } = {}) => {
  const normalized = {
    tenant_id:String(tenantId || "").trim().toLowerCase(),
    contact_reference:String(contactReference || "").trim(),
    lead_record_id:String(leadRecordId || "").trim(),
    subject_reference_hmac:String(subjectReferenceHmac || "").trim().toLowerCase(),
    contact_type:"mobile",
    purpose:"service_callback"
  };
  if (!normalized.tenant_id
      || !/^contact_[A-Za-z0-9_-]{16,128}$/.test(normalized.contact_reference)
      || !/^[0-9a-f-]{32,64}$/i.test(normalized.lead_record_id)
      || !/^[0-9a-f]{64}$/.test(normalized.subject_reference_hmac)) {
    throw vaultError("CONTACT_VAULT_AAD_REQUIRED", "Contact-vault encryption requires the complete tenant-scoped record identity");
  }
  return normalized;
};

const aadFor = (context, keyId, layer) => Buffer.from(JSON.stringify({
  schema:AAD_SCHEMA,
  algorithm:ALGORITHM,
  key_id:keyId,
  layer,
  ...normalizeContext(context)
}), "utf8");

const encryptAesGcm = (plaintext, key, aad) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv:iv.toString("base64url"),
    tag:cipher.getAuthTag().toString("base64url"),
    ciphertext:ciphertext.toString("base64url")
  };
};

const decodeEnvelopePart = (value, expectedLength = null) => {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid base64url envelope part");
  const decoded = Buffer.from(encoded, "base64url");
  if (!decoded.length
      || decoded.toString("base64url") !== encoded
      || (expectedLength !== null && decoded.length !== expectedLength)) {
    throw new Error("invalid envelope part length");
  }
  return decoded;
};

const decryptAesGcm = (parts, key, aad) => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    decodeEnvelopePart(parts.iv, 12)
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(decodeEnvelopePart(parts.tag, 16));
  return Buffer.concat([
    decipher.update(decodeEnvelopePart(parts.ciphertext)),
    decipher.final()
  ]);
};

const strictMobile = (value) => {
  const mobile = String(value || "").replace(/^\+?86/, "").replace(/[\s()-]/g, "");
  if (!/^1[3-9]\d{9}$/.test(mobile)) {
    const error = new Error("The contact-vault value is not a valid mainland mobile");
    error.code = "CONTACT_VAULT_MOBILE_INVALID";
    error.status = 400;
    throw error;
  }
  return mobile;
};

export const isContactVaultEnvelope = (value) => Boolean(
  value && typeof value === "object" && !Array.isArray(value)
    && value._encrypted === ENVELOPE_MARKER
    && value.version === 1
    && value.algorithm === ALGORITHM
    && value.kind === "mobile"
    && value.wrapped_data_key?.algorithm === ALGORITHM
    && value.wrapped_data_key?.kind === "data_key"
);

export function createContactVaultEncryption(options = {}) {
  const env = options.env || process.env;
  const production = options.production ?? productionEnvironment(env);
  const rawKeyring = options.keyringJson ?? env[CONTACT_VAULT_KEYRING_ENV] ?? "";
  const parsed = parseKeyring(rawKeyring);
  if (!parsed && production) {
    throw vaultError(
      "CONTACT_VAULT_KEYRING_REQUIRED",
      `${CONTACT_VAULT_KEYRING_ENV} is required in production`
    );
  }

  const requireKeyring = () => {
    if (!parsed) {
      throw vaultError(
        "CONTACT_VAULT_KEYRING_REQUIRED",
        "Durable contact storage requires a dedicated contact-vault keyring"
      );
    }
    return parsed;
  };

  const encryptMobile = (value, context) => {
    const keyring = requireKeyring();
    const mobile = strictMobile(value);
    const keyId = keyring.activeKeyId;
    const dataKey = randomBytes(32);
    const contactPlaintext = Buffer.from(mobile, "utf8");
    try {
      const valueEnvelope = encryptAesGcm(
        contactPlaintext,
        dataKey,
        aadFor(context, keyId, "contact_value")
      );
      const wrappedDataKey = encryptAesGcm(
        dataKey,
        keyring.keys.get(keyId),
        aadFor(context, keyId, "data_key_wrap")
      );
      return {
        _encrypted:ENVELOPE_MARKER,
        version:1,
        algorithm:ALGORITHM,
        key_id:keyId,
        kind:"mobile",
        ...valueEnvelope,
        wrapped_data_key:{
          algorithm:ALGORITHM,
          kind:"data_key",
          ...wrappedDataKey
        }
      };
    } finally {
      contactPlaintext.fill(0);
      dataKey.fill(0);
    }
  };

  const decryptMobile = (envelope, context) => {
    const keyring = requireKeyring();
    if (!isContactVaultEnvelope(envelope)) {
      throw vaultError("CONTACT_VAULT_ENVELOPE_INVALID", "Contact-vault envelope is invalid");
    }
    const keyId = String(envelope.key_id || "");
    const key = keyring.keys.get(keyId);
    if (!key) throw vaultError("CONTACT_VAULT_KEY_UNAVAILABLE", "Contact-vault key version is unavailable");
    let dataKey = null;
    let contactPlaintext = null;
    try {
      dataKey = decryptAesGcm(
        envelope.wrapped_data_key,
        key,
        aadFor(context, keyId, "data_key_wrap")
      );
      if (dataKey.length !== 32) throw new Error("invalid unwrapped data key length");
      contactPlaintext = decryptAesGcm(
        envelope,
        dataKey,
        aadFor(context, keyId, "contact_value")
      );
      return strictMobile(contactPlaintext.toString("utf8"));
    } catch (cause) {
      throw vaultError("CONTACT_VAULT_DECRYPTION_FAILED", "Contact-vault envelope authentication failed", cause);
    } finally {
      contactPlaintext?.fill(0);
      dataKey?.fill(0);
    }
  };

  return Object.freeze({
    enabled:Boolean(parsed),
    production,
    activeKeyId:parsed?.activeKeyId || null,
    keyIds:parsed ? [...parsed.keys.keys()] : [],
    encryptMobile,
    decryptMobile
  });
}
