import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (String(process.env.HUAMEI_PERSISTENCE_BACKEND || "").toLowerCase() !== "postgres") {
  throw new Error("该集成测试必须显式设置 HUAMEI_PERSISTENCE_BACKEND=postgres");
}
const databaseUrl = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "");
if (!databaseUrl) throw new Error("该集成测试需要 HUAMEI_DATABASE_URL");

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { prepareAcquisitionSessionContext } = await import("../server/acquisition-session.mjs");
const { createPostgresLangGraphTurnStore } = await import("../server/persistence/postgres-langgraph-turn-store.mjs");

const tenantId = `langgraph-turn-it-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const channel = "api";
const pin = { engine:"legacy", graph_version:"legacy", state_schema_version:"legacy" };
const database = createPostgresClient({
  connectionString:databaseUrl,
  applicationName:"huamei-langgraph-turn-protocol-it"
});
const store = createPostgresLangGraphTurnStore({ postgres:database, leaseMs:30_000 });

const decisionFor = ({ suffix = "1", text = "您好，我是上海华美医院顾问安安。" } = {}) => ({
  status:"prepared",
  run_id:`lg_run_${suffix}`,
  checkpoint_id:null,
  decision_hash:(suffix === "1" ? "a" : "b").repeat(64),
  conversation_update:{ safe_summary_ref:null, slot_updates:[], state_schema_version:"legacy" },
  response:{ segments:[text], citations:[], media_asset_ids:[], suggested_next_step:"" },
  handover:null,
  pending_action_preview:null,
  evidence:{ release_id:null, snapshot_id:null },
  policy:{ decision:"allow", reason_code:"GREETING_TEMPLATE" }
});

const contextFor = (conversationId, messageId) => ({
  tenantId,
  channel,
  externalConversationId:conversationId,
  inboundMessageId:messageId
});

const sessionSnapshot = async (sessionId) => {
  const result = await database.tenantQuery(tenantId,
    `SELECT id, state_version, next_commit_sequence, engine_pin
       FROM conversation_sessions
      WHERE tenant_id=$1 AND channel=$2 AND session_id=$3`,
    [tenantId, channel, sessionId]
  );
  return result.rows[0];
};

try {
  const conversationId = "langgraph-protocol-conversation";
  const sessionId = `${tenantId}:${channel}:${conversationId}`;
  const messageId = "langgraph-protocol-message-1";
  await prepareAcquisitionSessionContext(sessionId, "你好", [], contextFor(conversationId, messageId));
  const session = await sessionSnapshot(sessionId);
  assert.deepEqual(session.engine_pin, pin, "未切流会话必须仍使用 legacy engine pin");

  const lease = await store.acquireLease({
    tenantId, channel, sessionId, holderId:"langgraph-it-worker", enginePin:pin
  });
  assert.equal(lease.next_commit_sequence, 1);
  assert.equal(lease.expected_state_version, Number(session.state_version));
  const prepared = await store.prepareDecision({
    tenantId,
    channel,
    sessionId,
    messageId,
    turnSequence:lease.next_commit_sequence,
    expectedStateVersion:lease.expected_state_version,
    fencingToken:lease.fencing_token,
    enginePin:pin,
    decision:decisionFor(),
    traceId:"trace_langgraph_turn_it_1"
  });
  assert.equal(prepared.replay, false);
  assert.equal(prepared.turn_result.status, "prepared");
  assert.equal(prepared.turn_result.decision_status, "prepared");

  const replay = await store.prepareDecision({
    tenantId,
    channel,
    sessionId,
    messageId,
    turnSequence:lease.next_commit_sequence,
    expectedStateVersion:lease.expected_state_version,
    fencingToken:lease.fencing_token,
    enginePin:pin,
    decision:decisionFor(),
    traceId:"trace_langgraph_turn_it_1"
  });
  assert.equal(replay.replay, true, "相同消息和相同决策只能重放既有 prepared record");
  await assert.rejects(
    () => store.prepareDecision({
      tenantId,
      channel,
      sessionId,
      messageId,
      turnSequence:lease.next_commit_sequence,
      expectedStateVersion:lease.expected_state_version,
      fencingToken:lease.fencing_token,
      enginePin:pin,
      decision:decisionFor({ suffix:"2" })
    }),
    (error) => error?.code === "LANGGRAPH_PREPARED_DECISION_CONFLICT"
  );

  const committed = await store.commitPreparedDecision({
    tenantId, channel, sessionId, messageId, fencingToken:lease.fencing_token,
    traceId:"trace_langgraph_turn_it_1"
  });
  assert.equal(committed.replay, false);
  assert.equal(committed.turn_result.status, "committed");
  const commitReplay = await store.commitPreparedDecision({
    tenantId, channel, sessionId, messageId, fencingToken:lease.fencing_token
  });
  assert.equal(commitReplay.replay, true, "重复提交只能重放，不得要求仍持有已释放租约");

  const evidence = await database.tenantQuery(tenantId,
    `SELECT
       (SELECT count(*)::int FROM agent_turn_results WHERE tenant_id=$1 AND session_record_id=$2 AND status='committed') AS committed_results,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND action='langgraph.turn.committed') AS commit_audits,
       (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND event_type='langgraph.turn.committed') AS commit_events,
       (SELECT processing_state FROM conversation_messages WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3) AS inbound_processing_state,
       (SELECT count(*)::int FROM conversation_messages WHERE tenant_id=$1 AND session_record_id=$2 AND role='assistant') AS assistant_messages`,
    [tenantId, session.id, messageId]
  );
  assert.deepEqual(evidence.rows[0], {
    committed_results:1,
    commit_audits:1,
    commit_events:1,
    inbound_processing_state:"received",
    assistant_messages:0
  }, "P0 提交仅写协议审计，不得写客户可见回复或推进外部效果");

  const staleConversationId = "langgraph-stale-fence-conversation";
  const staleSessionId = `${tenantId}:${channel}:${staleConversationId}`;
  const staleMessageId = "langgraph-stale-fence-message-1";
  await prepareAcquisitionSessionContext(staleSessionId, "你好", [], contextFor(staleConversationId, staleMessageId));
  const firstLease = await store.acquireLease({
    tenantId, channel, sessionId:staleSessionId, holderId:"old-worker", enginePin:pin
  });
  await store.releaseLease({ tenantId, channel, sessionId:staleSessionId, fencingToken:firstLease.fencing_token });
  const currentLease = await store.acquireLease({
    tenantId, channel, sessionId:staleSessionId, holderId:"current-worker", enginePin:pin
  });
  await assert.rejects(
    () => store.prepareDecision({
      tenantId,
      channel,
      sessionId:staleSessionId,
      messageId:staleMessageId,
      turnSequence:currentLease.next_commit_sequence,
      expectedStateVersion:currentLease.expected_state_version,
      fencingToken:firstLease.fencing_token,
      enginePin:pin,
      decision:decisionFor()
    }),
    (error) => error?.code === "LANGGRAPH_TURN_FENCE_STALE"
  );

  console.log("✓ PostgreSQL LangGraph turn 协议：顺序、租约、fencing、prepared/commit 重放与 P0 无外发边界通过");
} finally {
  await closePostgresClient();
}
