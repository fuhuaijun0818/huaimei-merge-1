import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CONTACT_VAULT_KEYRING_ENV,
  createContactVaultEncryption,
  isContactVaultEnvelope,
  validateContactVaultKeyring
} from "../server/platform/contact-vault-encryption.mjs";

const keyring = (keyId, key = randomBytes(32).toString("base64")) => JSON.stringify({
  active_key_id:keyId,
  keys:{ [keyId]:key }
});
const contactKeyring = keyring("contact-v1");
const fieldKeyring = keyring("field-v1");
const context = {
  tenantId:"huamei-shanghai",
  contactReference:"contact_0123456789abcdef0123456789abcdef",
  leadRecordId:"01234567-89ab-cdef-0123-456789abcdef",
  subjectReferenceHmac:"a".repeat(64)
};

const validated = validateContactVaultKeyring(contactKeyring, {
  disallowedKeyrings:[fieldKeyring]
});
assert.equal(validated.valid, true);
assert.equal(validated.independent, true);

const reusedKey = JSON.parse(fieldKeyring).keys["field-v1"];
const reused = validateContactVaultKeyring(keyring("contact-reused", reusedKey), {
  disallowedKeyrings:[fieldKeyring]
});
assert.equal(reused.valid, false);
assert.equal(reused.errors[0].code, "CONTACT_VAULT_KEY_DOMAIN_REUSE_FORBIDDEN");

const encryption = createContactVaultEncryption({
  production:true,
  keyringJson:contactKeyring
});
const envelope = encryption.encryptMobile("+86 138 1234 5678", context);
assert.equal(isContactVaultEnvelope(envelope), true);
assert.equal(envelope.algorithm, "A256GCM");
assert.equal(envelope.kind, "mobile");
assert.equal(envelope.wrapped_data_key.algorithm, "A256GCM");
assert.equal(envelope.wrapped_data_key.kind, "data_key");
assert.doesNotMatch(JSON.stringify(envelope), /13812345678/);
assert.equal(encryption.decryptMobile(envelope, context), "13812345678");
const secondEnvelope = encryption.encryptMobile("13812345678", context);
assert.notEqual(
  secondEnvelope.wrapped_data_key.ciphertext,
  envelope.wrapped_data_key.ciphertext,
  "每次加密必须生成独立随机数据密钥"
);
assert.throws(
  () => encryption.decryptMobile({
    ...envelope,
    wrapped_data_key:{ ...envelope.wrapped_data_key, tag:`A${envelope.wrapped_data_key.tag.slice(1)}` }
  }, context),
  (error) => error.code === "CONTACT_VAULT_DECRYPTION_FAILED"
);
assert.throws(
  () => encryption.decryptMobile(envelope, { ...context, tenantId:"another-tenant" }),
  (error) => error.code === "CONTACT_VAULT_DECRYPTION_FAILED"
);
assert.throws(
  () => createContactVaultEncryption({ production:true, env:{} }),
  (error) => error.code === "CONTACT_VAULT_KEYRING_REQUIRED"
);
assert.throws(
  () => createContactVaultEncryption({
    production:true,
    env:{ [CONTACT_VAULT_KEYRING_ENV]:contactKeyring }
  }).encryptMobile("not-a-mobile", context),
  (error) => error.code === "CONTACT_VAULT_MOBILE_INVALID"
);

const encryptionSource = await readFile(new URL("../server/platform/contact-vault-encryption.mjs", import.meta.url), "utf8");
assert.match(encryptionSource, /contactPlaintext\?\.fill\(0\)/, "解密后的手机号Buffer必须在finally中清零");
assert.match(encryptionSource, /dataKey\?\.fill\(0\)/, "解包后的DEK Buffer必须在finally中清零");

console.log("✓ 联系方式保险库独立密钥域、AES-256-GCM信封加密/AAD绑定、密文脱敏与生产fail-closed通过");
