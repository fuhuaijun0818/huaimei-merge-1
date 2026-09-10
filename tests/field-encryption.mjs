import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  createFieldEncryption, createFieldRecordId, getFieldEncryptionEnvelopeMetadata,
  isFieldEncryptionEnvelope, validateFieldEncryptionKeyring
} from "../server/platform/field-encryption.mjs";

const firstKey = randomBytes(32).toString("base64");
const secondKey = randomBytes(32).toString("base64");
const oldKeyring = JSON.stringify({ active_key_id:"phase1-v1", keys:{ "phase1-v1":firstKey } });
const rotatedKeyring = JSON.stringify({
  active_key_id:"phase1-v2",
  keys:{ "phase1-v1":firstKey, "phase1-v2":secondKey }
});
const context = { tenantId:"tenant-a", scope:"conversation.session.state", recordId:"session-a" };

assert.equal(validateFieldEncryptionKeyring(rotatedKeyring).valid, true);
assert.equal(validateFieldEncryptionKeyring(JSON.stringify({
  active_key_id:"bad",
  keys:{ bad:randomBytes(31).toString("base64") }
})).valid, false);

const oldEncryption = createFieldEncryption({ keyringJson:oldKeyring, production:true });
const encrypted = oldEncryption.encryptJson({ concern:"仅本人可见的胎记咨询", budget:"一万" }, context);
assert.equal(isFieldEncryptionEnvelope(encrypted), true);
assert.equal(JSON.stringify(encrypted).includes("仅本人可见的胎记咨询"), false);
assert.deepEqual(oldEncryption.decryptJson(encrypted, context), { concern:"仅本人可见的胎记咨询", budget:"一万" });

await assert.rejects(
  async () => oldEncryption.decryptJson(encrypted, { ...context, tenantId:"tenant-b" }),
  (error) => error?.code === "FIELD_DECRYPTION_FAILED"
);
await assert.rejects(
  async () => oldEncryption.decryptJson(encrypted, { ...context, recordId:"session-b" }),
  (error) => error?.code === "FIELD_DECRYPTION_FAILED"
);

const tampered = {
  ...encrypted,
  ciphertext:`${encrypted.ciphertext.startsWith("A") ? "B" : "A"}${encrypted.ciphertext.slice(1)}`
};
await assert.rejects(
  async () => oldEncryption.decryptJson(tampered, context),
  (error) => error?.code === "FIELD_DECRYPTION_FAILED"
);

const rotatedEncryption = createFieldEncryption({ keyringJson:rotatedKeyring, production:true });
assert.deepEqual(rotatedEncryption.decryptJson(encrypted, context), { concern:"仅本人可见的胎记咨询", budget:"一万" });
assert.equal(rotatedEncryption.needsRotation(encrypted), true);
const rewrapped = rotatedEncryption.rewrapJson(encrypted, context);
assert.equal(rewrapped.key_id, "phase1-v2");
assert.equal(rotatedEncryption.needsRotation(rewrapped), false);
assert.deepEqual(rotatedEncryption.decryptJson(rewrapped, context), { concern:"仅本人可见的胎记咨询", budget:"一万" });

const textContext = { tenantId:"tenant-a", scope:"conversation.message.content", recordId:"message-a" };
const encryptedText = rotatedEncryption.encryptText("我的手机号13912345678", textContext);
assert.equal(encryptedText.includes("13912345678"), false);
assert.equal(rotatedEncryption.decryptText(encryptedText, textContext), "我的手机号13912345678");
assert.equal(rotatedEncryption.decryptText(rotatedEncryption.encryptText("", textContext), textContext), "");
const oldEncryptedText = oldEncryption.encryptText("旧版本文本", textContext);
assert.equal(rotatedEncryption.needsRotation(oldEncryptedText), true);
const rewrappedText = rotatedEncryption.rewrapText(oldEncryptedText, textContext);
assert.equal(rotatedEncryption.needsRotation(rewrappedText), false);
assert.equal(rotatedEncryption.decryptText(rewrappedText, textContext), "旧版本文本");

const collisionContextA = {
  tenantId:"tenant-a",
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", {
    channel:"web",
    session_id:"case",
    message_id:"turn:1"
  })
};
const collisionContextB = {
  tenantId:"tenant-a",
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", {
    channel:"web",
    session_id:"case:turn",
    message_id:"1"
  })
};
assert.notEqual(collisionContextA.recordId, collisionContextB.recordId, "结构化record ID必须保留每个业务键的边界");
const collisionEnvelope = rotatedEncryption.encryptText("只属于会话case的内容", collisionContextA);
await assert.rejects(
  async () => rotatedEncryption.decryptText(collisionEnvelope, collisionContextB),
  (error) => error?.code === "FIELD_DECRYPTION_FAILED"
);

const compositeCollisionCases = [
  {
    scope:"conversation.session.state",
    type:"conversation.session",
    left:{ channel:"web", session_id:"case:turn" },
    right:{ channel:"web:case", session_id:"turn" }
  },
  {
    scope:"conversation.message.session_snapshot",
    type:"conversation.message",
    left:{ channel:"web", session_id:"case", message_id:"turn:1" },
    right:{ channel:"web", session_id:"case:turn", message_id:"1" }
  },
  {
    scope:"human_work.notes",
    type:"human_work",
    left:{ conversation_id:"case", staff_id:"staff:1", recorded_at:"2026-08-26T00:00:00.000Z" },
    right:{ conversation_id:"case:staff", staff_id:"1", recorded_at:"2026-08-26T00:00:00.000Z" }
  }
];
for (const [index, collisionCase] of compositeCollisionCases.entries()) {
  const left = {
    tenantId:"tenant-a",
    scope:collisionCase.scope,
    recordId:createFieldRecordId(collisionCase.type, collisionCase.left)
  };
  const right = {
    tenantId:"tenant-a",
    scope:collisionCase.scope,
    recordId:createFieldRecordId(collisionCase.type, collisionCase.right)
  };
  assert.notEqual(left.recordId, right.recordId);
  const protectedValue = rotatedEncryption.encryptJson({ collision_case:index }, left);
  await assert.rejects(
    async () => rotatedEncryption.decryptJson(protectedValue, right),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED"
  );
}

const legacyContext = {
  tenantId:"tenant-a",
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", {
    channel:"web",
    session_id:"legacy:session",
    message_id:"message:1"
  }),
  legacyRecordId:"web:legacy:session:message:1"
};
const legacyIv = randomBytes(12);
const legacyCipher = createCipheriv("aes-256-gcm", Buffer.from(firstKey, "base64"), legacyIv);
legacyCipher.setAAD(Buffer.from(JSON.stringify({
  schema:"huamei.field.aad.v1",
  algorithm:"A256GCM",
  key_id:"phase1-v1",
  kind:"text",
  tenant_id:legacyContext.tenantId,
  scope:legacyContext.scope,
  record_id:legacyContext.legacyRecordId
}), "utf8"));
const legacyCiphertext = Buffer.concat([
  legacyCipher.update(Buffer.from("升级前的加密消息", "utf8")),
  legacyCipher.final()
]);
const legacyEnvelope = JSON.stringify({
  _encrypted:"huamei.field.a256gcm.v1",
  version:1,
  algorithm:"A256GCM",
  key_id:"phase1-v1",
  kind:"text",
  iv:legacyIv.toString("base64url"),
  tag:legacyCipher.getAuthTag().toString("base64url"),
  ciphertext:legacyCiphertext.toString("base64url")
});
assert.equal(rotatedEncryption.decryptText(legacyEnvelope, legacyContext), "升级前的加密消息");
assert.equal(rotatedEncryption.needsRotation(legacyEnvelope), true, "旧AAD scheme即使使用活动密钥也必须重包");
const upgradedLegacyEnvelope = rotatedEncryption.rewrapText(legacyEnvelope, legacyContext);
assert.equal(getFieldEncryptionEnvelopeMetadata(upgradedLegacyEnvelope).current, true);
assert.equal(rotatedEncryption.decryptText(upgradedLegacyEnvelope, legacyContext), "升级前的加密消息");
await assert.rejects(
  async () => rotatedEncryption.decryptText(legacyEnvelope, { ...legacyContext, legacyRecordId:undefined }),
  (error) => error?.code === "FIELD_ENCRYPTION_LEGACY_AAD_REQUIRED"
);

const development = createFieldEncryption({ env:{ NODE_ENV:"development" } });
assert.deepEqual(development.encryptJson({ safe:"local" }, context), { safe:"local" });
assert.deepEqual(development.decryptJson({ safe:"local" }, context), { safe:"local" });
assert.equal(development.encryptText("local", textContext), "local");

assert.throws(
  () => createFieldEncryption({ env:{ NODE_ENV:"production" } }),
  (error) => error?.code === "FIELD_ENCRYPTION_KEYRING_REQUIRED"
);
assert.throws(
  () => rotatedEncryption.decryptJson({ plaintext:true }, context),
  (error) => error?.code === "FIELD_PLAINTEXT_FORBIDDEN"
);
const missingOldKey = createFieldEncryption({
  keyringJson:JSON.stringify({ active_key_id:"phase1-v2", keys:{ "phase1-v2":secondKey } }),
  production:true
});
assert.throws(
  () => missingOldKey.decryptJson(encrypted, context),
  (error) => error?.code === "FIELD_ENCRYPTION_KEY_UNAVAILABLE"
);

console.log("✓ AES-256-GCM密钥环、AAD隔离、篡改失败、轮换与生产fail-closed通过");
