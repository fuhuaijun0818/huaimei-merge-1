import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const originalBackend = process.env.HUAMEI_PERSISTENCE_BACKEND;
const originalStore = process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";

try {
  const {
    assertHandoverReplyAuthorization,
    claimHandover,
    completeHandover,
    ensureHandoverTask,
    resetOperationsStoreForTest
  } = await import(`../server/acquisition-operations-store.mjs?b010-reply-authorization=${Date.now()}`);

  resetOperationsStoreForTest();
  const tenantId = "tenant-b010";
  const conversationId = "conversation-b010-ac1";
  const owner = "advisor-a";
  const otherAdvisor = "advisor-b";
  const task = await ensureHandoverTask({
    envelope:{
      tenant_id:tenantId,
      channel:"web",
      conversation_id:conversationId,
      actor:{ external_user_id:"visitor-b010" },
      message:{ id:"message-b010-ac1", text:"请人工顾问联系我" }
    },
    result:{ status:"handover_required", handover:{ required:true, reason:"human_request", to_team:"人工咨询" } }
  });
  const claimed = await claimHandover(task.id, { tenant_id:tenantId, assignee:owner });

  await assert.rejects(
    () => assertHandoverReplyAuthorization({
      tenant_id:tenantId,
      conversation_id:conversationId,
      actor:otherAdvisor,
      expected_handover_version:claimed.updated_at
    }),
    (error) => error.code === "HANDOVER_REPLY_ASSIGNEE_FORBIDDEN" && error.status === 403,
    "非当前接管顾问即使知道会话编号也必须被拒绝"
  );

  await assert.rejects(
    () => assertHandoverReplyAuthorization({
      tenant_id:tenantId,
      conversation_id:conversationId,
      actor:owner,
      expected_handover_version:"stale-handover-version"
    }),
    (error) => error.code === "HANDOVER_REPLY_STATE_STALE" && error.status === 409,
    "当前接管人也不能使用旧接管状态版本发送"
  );

  const authorized = await assertHandoverReplyAuthorization({
    tenant_id:tenantId,
    conversation_id:conversationId,
    actor:owner,
    expected_handover_version:claimed.updated_at
  });
  assert.equal(authorized.id, task.id);
  assert.equal(authorized.assignee, owner);

  await completeHandover(task.id, { tenant_id:tenantId, actor:owner, resolution:"验收结束" });
  await assert.rejects(
    () => assertHandoverReplyAuthorization({
      tenant_id:tenantId,
      conversation_id:conversationId,
      actor:owner,
      expected_handover_version:claimed.updated_at
    }),
    (error) => error.code === "HANDOVER_REPLY_STATE_STALE" && error.status === 409,
    "任务完结后，旧会话编号不能再发送人工消息"
  );

  const router = await readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8");
  const guardAt = router.indexOf("await assertHandoverReplyAuthorization");
  const appendAt = router.indexOf("await appendAcquisitionConversationReply");
  assert.ok(guardAt >= 0 && guardAt < appendAt, "BFF必须先完成接管权校验，才可以写入人工消息");

  console.log("✓ B010 AC1 当前接管人、状态版本与完结后旧会话回复均受服务端拦截");
} finally {
  if (originalBackend === undefined) delete process.env.HUAMEI_PERSISTENCE_BACKEND;
  else process.env.HUAMEI_PERSISTENCE_BACKEND = originalBackend;
  if (originalStore === undefined) delete process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
  else process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = originalStore;
}
