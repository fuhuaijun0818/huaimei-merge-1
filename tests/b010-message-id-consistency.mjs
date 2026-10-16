import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousBackend = process.env.HUAMEI_PERSISTENCE_BACKEND;
const previousLeadStore = process.env.HUAMEI_LEAD_STORE_FILE;
const previousOperationsStore = process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
const previousConversationStore = process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE;
const conversationStoreDirectory = await mkdtemp(join(tmpdir(), "huamei-b010-ac2-"));
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE = join(conversationStoreDirectory, "conversations.json");

try {
  const {
    acquisitionCustomerSnapshot,
    appendAcquisitionConversationReply,
    getAcquisitionConversationStaffMessages,
    recordAcquisitionConversationDelivery,
    resetLeadStoreForTest,
    upsertAcquisitionLead
  } = await import(`../server/lead-store.mjs?b010-message-id=${Date.now()}`);
  const { recordLocalConversation } = await import(`../server/local-conversation-store.mjs?b010-message-id=${Date.now()}`);

  resetLeadStoreForTest();
  const tenantId = "tenant-b010-ac2";
  const externalConversationId = "ps-b010-ac2-message-id";
  const marker = "B010AC2-01 您好，我来帮您了解。";
  const replyIdempotencyKey = "b010-ac4-stable-retry-key";
  await upsertAcquisitionLead({
    tenant_id:tenantId,
    session_id:externalConversationId,
    mobile:"13912345678",
    name:"B010AC2验收",
    service_consent:true,
    messages:[{ role:"user", content:"我希望人工顾问联系我" }]
  });
  recordLocalConversation({
    tenant_id:tenantId,
    channel:"web",
    conversation_id:externalConversationId,
    message:{ id:"b010-ac2-inbound", text:"我希望人工顾问联系我", timestamp:new Date().toISOString() }
  }, { reply:{ text:"好的，已为您转人工顾问。" } });

  const receipt = await appendAcquisitionConversationReply({
    tenant_id:tenantId,
    // B010 的接管与写入边界均使用前台 ps_ 会话编号，不能传 V-AI 内部投影 ID。
    conversation_id:externalConversationId,
    text:marker,
    actor:"advisor-b010",
    idempotency_key:replyIdempotencyKey
  });
  const submitted = receipt.conversation.messages.at(-1);
  assert.equal(submitted.from, "staff");
  assert.equal(submitted.text, marker);
  assert.ok(submitted.id, "成功回执必须包含统一消息 ID");
  assert.equal(receipt.delivery.delivery_status, "pending", "后台提交不能伪装成已送达");
  assert.equal(receipt.delivery.read_status, "not_reported", "后台提交不能伪装成客户已读");

  const replay = await appendAcquisitionConversationReply({
    tenant_id:tenantId,
    conversation_id:externalConversationId,
    text:marker,
    actor:"advisor-b010",
    idempotency_key:replyIdempotencyKey
  });
  assert.equal(replay.replayed, true, "同一发送标识的重试必须返回已提交消息");
  assert.equal(replay.message.id, submitted.id, "重试必须返回稳定消息 ID");
  await assert.rejects(
    () => appendAcquisitionConversationReply({
      tenant_id:tenantId,
      conversation_id:externalConversationId,
      text:"B010AC4-同键不同内容必须拒绝",
      actor:"advisor-b010",
      idempotency_key:replyIdempotencyKey
    }),
    (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH" && error.status === 409,
    "同一发送标识不能被复用于不同正文"
  );

  const snapshot = await acquisitionCustomerSnapshot(tenantId);
  const archived = snapshot.conversations
    .find((conversation) => conversation.externalConversationId === externalConversationId)
    ?.messages.find((message) => message.id === submitted.id);
  assert.ok(archived, "归档读取必须返回与发送回执相同的消息 ID");
  assert.equal(archived.text, marker);
  assert.equal(archived.id, submitted.id);
  assert.equal(snapshot.conversations
    .find((conversation) => conversation.externalConversationId === externalConversationId)
    ?.messages.filter((message) => message.id === submitted.id).length, 1,
  "同一发送标识重试不能写入第二条人工消息");

  const delivered = await recordAcquisitionConversationDelivery({
    tenant_id:tenantId,
    conversation_id:externalConversationId,
    message_id:submitted.id
  });
  assert.equal(delivered.message.id, submitted.id);
  assert.equal(delivered.message.delivery.delivery_status, "delivered");
  assert.equal(delivered.message.delivery.read_status, "not_reported");
  const publicStaffMessages = await getAcquisitionConversationStaffMessages({
    tenant_id:tenantId,
    conversation_id:externalConversationId
  });
  assert.equal(publicStaffMessages.find((message) => message.id === submitted.id)?.delivery?.delivery_status, "delivered");

  const frontendSnapshot = await acquisitionCustomerSnapshot(tenantId, { includeLiveConversations:true });
  const frontendMessage = frontendSnapshot.conversations
    .find((conversation) => conversation.externalConversationId === externalConversationId)
    ?.messages.find((message) => message.id === submitted.id);
  assert.ok(frontendMessage, "实时会话投影不能覆盖已归档的人工消息");
  assert.equal(frontendMessage.from, "staff");
  assert.equal(frontendMessage.text, marker);

  const visitorOnlyConversationId = "ps-b010-ac2-visitor-only";
  const visitorOnlyMarker = "B010AC2-未留资访客也可收到人工回复。";
  recordLocalConversation({
    tenant_id:tenantId,
    channel:"web",
    conversation_id:visitorOnlyConversationId,
    message:{ id:"b010-ac2-visitor-inbound", text:"请人工顾问接待", timestamp:new Date().toISOString() }
  }, { reply:{ text:"已转人工顾问。" } });
  const visitorOnlyReply = await appendAcquisitionConversationReply({
    tenant_id:tenantId,
    conversation_id:visitorOnlyConversationId,
    text:visitorOnlyMarker,
    actor:"advisor-b010",
    idempotency_key:"b010-visitor-only-retry-key"
  });
  assert.equal(visitorOnlyReply.message.from, "staff", "未留资访客也必须写入统一会话记录");
  assert.equal(visitorOnlyReply.message.text, visitorOnlyMarker);
  const visitorOnlyReplay = await appendAcquisitionConversationReply({
    tenant_id:tenantId,
    conversation_id:visitorOnlyConversationId,
    text:visitorOnlyMarker,
    actor:"advisor-b010",
    idempotency_key:"b010-visitor-only-retry-key"
  });
  assert.equal(visitorOnlyReplay.replayed, true, "未留资访客的人工回复也必须幂等");
  const visitorOnlyDelivered = await recordAcquisitionConversationDelivery({
    tenant_id:tenantId,
    conversation_id:visitorOnlyConversationId,
    message_id:visitorOnlyReply.message.id
  });
  assert.equal(visitorOnlyDelivered.message.delivery.delivery_status, "delivered");
  const visitorOnlyPublic = await getAcquisitionConversationStaffMessages({ tenant_id:tenantId, conversation_id:visitorOnlyConversationId });
  assert.equal(visitorOnlyPublic.find((message) => message.id === visitorOnlyReply.message.id)?.delivery?.delivery_status, "delivered");

  console.log("✓ B010 AC2 消息 ID 一致，未留资访客回复、AC3 送达状态与 AC4 稳定重试去重正确区分");
} finally {
  if (previousBackend === undefined) delete process.env.HUAMEI_PERSISTENCE_BACKEND;
  else process.env.HUAMEI_PERSISTENCE_BACKEND = previousBackend;
  if (previousLeadStore === undefined) delete process.env.HUAMEI_LEAD_STORE_FILE;
  else process.env.HUAMEI_LEAD_STORE_FILE = previousLeadStore;
  if (previousOperationsStore === undefined) delete process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
  else process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = previousOperationsStore;
  if (previousConversationStore === undefined) delete process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE;
  else process.env.HUAMEI_LOCAL_CONVERSATION_STORE_FILE = previousConversationStore;
  await rm(conversationStoreDirectory, { recursive:true, force:true });
}
