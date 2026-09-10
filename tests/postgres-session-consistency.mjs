import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

if (String(process.env.HUAMEI_PERSISTENCE_BACKEND || "").toLowerCase() !== "postgres") {
  throw new Error("该集成测试必须显式设置 HUAMEI_PERSISTENCE_BACKEND=postgres");
}
const databaseUrl = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "");
if (!databaseUrl) throw new Error("该集成测试需要 HUAMEI_DATABASE_URL");

const tenantId = `session-it-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const channel = "api";
process.env.HUAMEI_LLM_ENABLED = "false";

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { getPostgresAcquisitionSessionStore } = await import("../server/persistence/postgres-session-store.mjs");
const { createPostgresOperationsStore } = await import("../server/persistence/postgres-operations-store.mjs");
const { runConversationReceiptRecoveryPass } = await import("../server/workers/conversation-receipt-recovery-worker.mjs");
const {
  getAcquisitionSession,
  prepareAcquisitionSessionContext,
  recordAcquisitionSessionTurn
} = await import("../server/acquisition-session.mjs");

const database = createPostgresClient({
  connectionString:databaseUrl,
  applicationName:"huamei-session-consistency-it"
});
const payload = (message, reply, project) => ({
  message,
  projects:[project],
  result:{
    status:"completed",
    output:{
      message:reply,
      citations:[{ source_record_id:`KB-${project}` }],
      structured_data:{
        intent:"project_consult",
        intent_analysis:{ primary_intent:"project_consult", entities:{ projects:[project] } }
      }
    }
  }
});
const meta = (conversationId, messageId) => ({
  tenantId,
  channel,
  externalConversationId:conversationId,
  inboundMessageId:messageId
});
const expectedAssistantId = (sessionId, inboundMessageId) => `reply_${createHash("sha256")
  .update(`${sessionId}\u0000${inboundMessageId}\u0000assistant`)
  .digest("hex")}`;

try {
  const orderedConversationId = "ordered-conversation";
  const orderedSessionId = `${tenantId}:${channel}:${orderedConversationId}`;
  const orderedMeta1 = meta(orderedConversationId, "ordered-inbound-1");
  const orderedMeta2 = meta(orderedConversationId, "ordered-inbound-2");
  await prepareAcquisitionSessionContext(orderedSessionId, "先了解双眼皮", [], orderedMeta1);
  await prepareAcquisitionSessionContext(orderedSessionId, "再了解隆鼻", [], orderedMeta2);

  await assert.rejects(
    () => recordAcquisitionSessionTurn(
      orderedSessionId,
      payload("再了解隆鼻", "这是第二条回复", "隆鼻"),
      orderedMeta2
    ),
    (error) => error.code === "POSTGRES_CONVERSATION_SEQUENCE_PENDING"
      && error.details.expected_sequence === 1
      && error.details.actual_sequence === 2
  );
  const first = await recordAcquisitionSessionTurn(
    orderedSessionId,
    payload("先了解双眼皮", "这是第一条回复", "双眼皮"),
    orderedMeta1
  );
  assert.equal(first.turn_count, 1);
  const firstReplays = await Promise.all(Array.from({ length:12 }, () => recordAcquisitionSessionTurn(
    orderedSessionId,
    payload("先了解双眼皮", "重放不得覆盖第一条回复", "双眼皮"),
    orderedMeta1
  )));
  assert.ok(firstReplays.every((item) => item.turn_count === 1));
  const second = await recordAcquisitionSessionTurn(
    orderedSessionId,
    payload("再了解隆鼻", "这是第二条回复", "隆鼻"),
    orderedMeta2
  );
  assert.equal(second.turn_count, 2);
  assert.equal((await getAcquisitionSession(orderedSessionId, orderedMeta1)).turn_count, 2);
  await assert.rejects(
    () => prepareAcquisitionSessionContext(orderedSessionId, "复用ID但内容已经变化", [], orderedMeta1),
    (error) => error.code === "CONVERSATION_MESSAGE_ID_REUSED"
  );

  const orderedEvidence = await database.tenantQuery(tenantId,
    `SELECT s.next_turn_sequence, s.next_commit_sequence, s.state_version, s.state,
       (SELECT count(*) FROM conversation_messages m
        WHERE m.tenant_id=s.tenant_id AND m.session_record_id=s.id)::int AS message_count,
       (SELECT count(DISTINCT m.message_id) FROM conversation_messages m
        WHERE m.tenant_id=s.tenant_id AND m.session_record_id=s.id)::int AS distinct_message_count,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=s.tenant_id AND o.aggregate_id=s.session_id
          AND o.event_type='conversation.turn.recorded')::int AS turn_events
     FROM conversation_sessions s
     WHERE s.tenant_id=$1 AND s.channel=$2 AND s.session_id=$3`,
    [tenantId, channel, orderedSessionId]
  );
  assert.equal(Number(orderedEvidence.rows[0].next_turn_sequence), 3);
  assert.equal(Number(orderedEvidence.rows[0].next_commit_sequence), 3);
  assert.equal(Number(orderedEvidence.rows[0].state_version), 4);
  assert.equal(orderedEvidence.rows[0].state.counters.completed, 2);
  assert.equal(orderedEvidence.rows[0].state.counters.grounded, 2);
  assert.equal(orderedEvidence.rows[0].message_count, 4);
  assert.equal(orderedEvidence.rows[0].distinct_message_count, 4);
  assert.equal(orderedEvidence.rows[0].turn_events, 2);
  const orderedMessages = await database.tenantQuery(tenantId,
    `SELECT message_id, role, direction, turn_sequence, parent_message_id, content
     FROM conversation_messages m
     JOIN conversation_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
     WHERE m.tenant_id=$1 AND s.session_id=$2
     ORDER BY m.turn_sequence, CASE m.role WHEN 'user' THEN 0 ELSE 1 END`,
    [tenantId, orderedSessionId]
  );
  assert.deepEqual(orderedMessages.rows.map((row) => ({
    message_id:row.message_id,
    role:row.role,
    sequence:Number(row.turn_sequence),
    parent_message_id:row.parent_message_id
  })), [
    { message_id:"ordered-inbound-1", role:"user", sequence:1, parent_message_id:null },
    { message_id:expectedAssistantId(orderedSessionId, "ordered-inbound-1"), role:"assistant", sequence:1, parent_message_id:"ordered-inbound-1" },
    { message_id:"ordered-inbound-2", role:"user", sequence:2, parent_message_id:null },
    { message_id:expectedAssistantId(orderedSessionId, "ordered-inbound-2"), role:"assistant", sequence:2, parent_message_id:"ordered-inbound-2" }
  ]);
  assert.equal(orderedMessages.rows[1].content, "这是第一条回复", "重放不得覆盖首次落库回复");

  const replayConversationId = "same-message-conversation";
  const replaySessionId = `${tenantId}:${channel}:${replayConversationId}`;
  const replayMeta = meta(replayConversationId, "same-inbound-1");
  const prepareResults = await Promise.all(Array.from({ length:20 }, () =>
    prepareAcquisitionSessionContext(replaySessionId, "我想了解光子嫩肤", [], replayMeta)
  ));
  assert.ok(prepareResults.every((item) => item.known_projects.includes("光子嫩肤")));
  const recordResults = await Promise.all(Array.from({ length:20 }, () =>
    recordAcquisitionSessionTurn(
      replaySessionId,
      payload("我想了解光子嫩肤", "这里是光子嫩肤的一般信息", "光子嫩肤"),
      replayMeta
    )
  ));
  assert.ok(recordResults.every((item) => item.turn_count === 1));
  const replayEvidence = await database.tenantQuery(tenantId,
    `SELECT s.next_turn_sequence, s.next_commit_sequence, s.state_version, s.state,
       (SELECT count(*) FROM conversation_messages m
        WHERE m.tenant_id=s.tenant_id AND m.session_record_id=s.id)::int AS message_count,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=s.tenant_id AND o.aggregate_id=s.session_id
          AND o.event_type='conversation.turn.recorded')::int AS turn_events
     FROM conversation_sessions s
     WHERE s.tenant_id=$1 AND s.channel=$2 AND s.session_id=$3`,
    [tenantId, channel, replaySessionId]
  );
  assert.equal(Number(replayEvidence.rows[0].next_turn_sequence), 2);
  assert.equal(Number(replayEvidence.rows[0].next_commit_sequence), 2);
  assert.equal(Number(replayEvidence.rows[0].state_version), 2);
  assert.equal(replayEvidence.rows[0].state.counters.completed, 1);
  assert.equal(replayEvidence.rows[0].message_count, 2);
  assert.equal(replayEvidence.rows[0].turn_events, 1);

  const recoveryConversationId = "recovery-conversation";
  const recoverySessionId = `${tenantId}:${channel}:${recoveryConversationId}`;
  const recoveryMeta1 = meta(recoveryConversationId, "recovery-inbound-1");
  const recoveryMeta2 = meta(recoveryConversationId, "recovery-inbound-2");
  await prepareAcquisitionSessionContext(recoverySessionId, "第一条消息将模拟处理超时", [], recoveryMeta1);
  await prepareAcquisitionSessionContext(recoverySessionId, "第二条消息必须等待恢复", [], recoveryMeta2);
  await database.tenantQuery(tenantId,
    `UPDATE conversation_messages m
     SET processing_deadline_at=clock_timestamp()-interval '1 second'
     FROM conversation_sessions s
     WHERE m.tenant_id=$1 AND s.tenant_id=m.tenant_id AND s.id=m.session_record_id
       AND s.session_id=$2 AND m.message_id=$3`,
    [tenantId, recoverySessionId, "recovery-inbound-1"]
  );
  const recoveryStore = getPostgresAcquisitionSessionStore();
  const recoveryPass = await runConversationReceiptRecoveryPass({
    store:recoveryStore,
    tenantIds:[tenantId],
    now:new Date().toISOString()
  });
  assert.equal(recoveryPass.failed_receipts, 1);
  await assert.rejects(
    () => recordAcquisitionSessionTurn(
      recoverySessionId,
      payload("第一条消息将模拟处理超时", "迟到的旧执行不得越过失败终态", "双眼皮"),
      recoveryMeta1
    ),
    (error) => error.code === "CONVERSATION_RECEIPT_FAILED_REPLAY_REQUIRED"
  );
  await assert.rejects(
    () => recordAcquisitionSessionTurn(
      recoverySessionId,
      payload("第二条消息必须等待恢复", "第二条回复", "隆鼻"),
      recoveryMeta2
    ),
    (error) => error.code === "CONVERSATION_PREDECESSOR_FAILED"
      && error.details.failed_message_id === "recovery-inbound-1"
  );
  const blockedCursor = await database.tenantQuery(tenantId,
    `SELECT next_turn_sequence, next_commit_sequence
     FROM conversation_sessions WHERE tenant_id=$1 AND session_id=$2`,
    [tenantId, recoverySessionId]
  );
  assert.equal(Number(blockedCursor.rows[0].next_turn_sequence), 3);
  assert.equal(Number(blockedCursor.rows[0].next_commit_sequence), 1, "超时失败不得静默推进提交游标");

  await prepareAcquisitionSessionContext(
    recoverySessionId,
    "第一条消息将模拟处理超时",
    [],
    recoveryMeta1
  );
  assert.equal((await recordAcquisitionSessionTurn(
    recoverySessionId,
    payload("第一条消息将模拟处理超时", "第一条重放恢复成功", "双眼皮"),
    recoveryMeta1
  )).turn_count, 1);
  assert.equal((await recordAcquisitionSessionTurn(
    recoverySessionId,
    payload("第二条消息必须等待恢复", "第二条按原序提交成功", "隆鼻"),
    recoveryMeta2
  )).turn_count, 2);
  const recoveryEvidence = await database.tenantQuery(tenantId,
    `SELECT s.next_turn_sequence, s.next_commit_sequence, s.state,
       (SELECT count(*) FROM conversation_messages m
        WHERE m.tenant_id=s.tenant_id AND m.session_record_id=s.id)::int AS message_count,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=s.tenant_id AND o.aggregate_id=s.session_id
          AND o.event_type='conversation.turn.failed')::int AS failure_events,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=s.tenant_id AND o.aggregate_id=s.session_id
          AND o.event_type='conversation.turn.recorded')::int AS recorded_events,
       (SELECT count(*) FROM audit_events a
        WHERE a.tenant_id=s.tenant_id
          AND a.resource_id=s.session_id || ':recovery-inbound-1'
          AND a.action='conversation.turn.failed')::int AS failure_audits
     FROM conversation_sessions s
     WHERE s.tenant_id=$1 AND s.session_id=$2`,
    [tenantId, recoverySessionId]
  );
  assert.equal(Number(recoveryEvidence.rows[0].next_turn_sequence), 3);
  assert.equal(Number(recoveryEvidence.rows[0].next_commit_sequence), 3);
  assert.equal(recoveryEvidence.rows[0].state.counters.completed, 2);
  assert.equal(recoveryEvidence.rows[0].message_count, 4);
  assert.equal(recoveryEvidence.rows[0].failure_events, 1);
  assert.equal(recoveryEvidence.rows[0].recorded_events, 2);
  assert.equal(recoveryEvidence.rows[0].failure_audits, 1);
  const recoveredReceipt = await database.tenantQuery(tenantId,
    `SELECT processing_state, processing_attempts, processing_deadline_at,
       processing_completed_at, processing_failed_at, failure_code
     FROM conversation_messages m
     JOIN conversation_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
     WHERE m.tenant_id=$1 AND s.session_id=$2 AND m.message_id=$3`,
    [tenantId, recoverySessionId, "recovery-inbound-1"]
  );
  assert.equal(recoveredReceipt.rows[0].processing_state, "completed");
  assert.equal(recoveredReceipt.rows[0].processing_attempts, 2);
  assert.equal(recoveredReceipt.rows[0].processing_deadline_at, null);
  assert.ok(recoveredReceipt.rows[0].processing_completed_at);
  assert.equal(recoveredReceipt.rows[0].processing_failed_at, null);
  assert.equal(recoveredReceipt.rows[0].failure_code, null);
  assert.equal((await runConversationReceiptRecoveryPass({
    store:recoveryStore,
    tenantIds:[tenantId],
    now:new Date().toISOString()
  })).failed_receipts, 0, "恢复worker重跑不得重复终结同一收件");

  const operations = createPostgresOperationsStore({ postgres:database });
  const handoverConversationId = "handover-idempotency-conversation";
  const handoverEnvelope = {
    tenant_id:tenantId,
    channel,
    conversation_id:handoverConversationId,
    actor:{ external_user_id:"handover-customer" },
    message:{ id:"handover-trigger", text:"请转人工顾问" }
  };
  const handover = await operations.ensureHandoverTask({
    envelope:handoverEnvelope,
    result:{ status:"handover_required", handover:{ required:true, reason:"human_requested", to_team:"人工咨询" } },
    sessionSnapshot:{ conversation_summary:"客户主动要求人工", known_slots:{}, projects:[] },
    contactInitiation:"customer_inbound",
    safeText:(value, limit = 500) => String(value || "").slice(0, limit)
  });
  await operations.claimHandover({ handoverId:handover.id, tenantId, assignee:"恢复测试顾问" });
  const handoverInbound = {
    ...handoverEnvelope,
    message:{ id:"handover-human-inbound-1", text:"人工接管后补充的同一条消息" }
  };
  const handoverReplays = await Promise.all(Array.from({ length:20 }, () =>
    operations.recordInbound(
      handover,
      handoverInbound,
      (value, limit = 500) => String(value || "").slice(0, limit)
    )
  ));
  assert.equal(handoverReplays.filter((item) => item.duplicate === false).length, 1);
  assert.equal(handoverReplays.filter((item) => item.duplicate === true).length, 19);
  await assert.rejects(
    () => operations.recordInbound(
      handover,
      { ...handoverInbound, message:{ ...handoverInbound.message, text:"复用同一消息ID但内容已经改变" } },
      (value, limit = 500) => String(value || "").slice(0, limit)
    ),
    (error) => error.code === "CONVERSATION_MESSAGE_ID_REUSED"
  );
  const handoverReplayEvidence = await database.tenantQuery(tenantId,
    `SELECT
       (SELECT count(*) FROM conversation_messages m
        WHERE m.tenant_id=$1 AND m.message_id=$2)::int AS messages,
       (SELECT count(*) FROM audit_events a
        WHERE a.tenant_id=$1 AND a.resource_id=$3
          AND a.action='handover.inbound_received')::int AS audits,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=$1 AND o.aggregate_id=$3
          AND o.event_type='handover.inbound_received')::int AS outbox_events`,
    [tenantId, handoverInbound.message.id, handover.id]
  );
  assert.deepEqual(handoverReplayEvidence.rows[0], { messages:1, audits:1, outbox_events:1 });

  console.log(`✓ PostgreSQL渠道收件幂等、确定序号、并发重放、超时恢复与人工接管入站单写通过（${tenantId}）`);
} finally {
  await Promise.allSettled([database.close(), closePostgresClient()]);
}
