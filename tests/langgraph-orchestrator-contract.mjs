import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  LANGGRAPH_CONTRACT_VERSION,
  assertLangGraphTurnDecision,
  createLangGraphTurnRequest,
  deriveLangGraphThreadId,
  issueLangGraphServiceToken
} from "../server/langgraph-orchestrator-contract.mjs";
import { readLangGraphOrchestratorConfig, requestLangGraphTurn } from "../server/langgraph-orchestrator-client.mjs";

const serviceSecret = "orchestrator_contract_secret_7wP6yQ5rT4uE3iO2aS1dF0gH";
const threadSecret = "orchestrator_thread_secret_7wP6yQ5rT4uE3iO2aS1dF0gH";
const input = {
  tenantId:"huamei-shanghai",
  channel:"web",
  conversationId:"conversation_opaque_1",
  messageId:"message_opaque_1",
  message:"请联系我 138 1234 5678，想了解华美隆胸项目",
  turnSequence:4,
  expectedStateVersion:8,
  fencingToken:12,
  authorizationContext:"authorized-local-gateway-context",
  traceId:"req_langgraph_contract_1",
  threadSecret
};

const built = createLangGraphTurnRequest(input);
assert.equal(built.request.contract_version, LANGGRAPH_CONTRACT_VERSION);
assert.equal(built.request.turn.turn_seq, 4);
assert.match(built.threadId, /^lgth_[A-Za-z0-9_-]{43}$/);
assert.doesNotMatch(built.threadId, /conversation|138|1234/i);
assert.doesNotMatch(built.request.input.redacted_message, /138\s*1234\s*5678/);
assert.equal(built.request.turn.payload_hash, createHash("sha256").update(built.request.input.redacted_message).digest("hex"));
assert.equal(
  built.threadId,
  deriveLangGraphThreadId({ tenantId:input.tenantId, channel:input.channel, conversationId:input.conversationId, secret:threadSecret })
);

const token = issueLangGraphServiceToken({
  secret:serviceSecret,
  tenantId:input.tenantId,
  authorizationContext:input.authorizationContext,
  now:1_700_000_000
});
assert.equal(token.split(".").length, 3);

const decision = {
  status:"interrupted",
  run_id:"lg_run_1",
  checkpoint_id:"cp_1",
  decision_hash:"a".repeat(64),
  conversation_update:{ safe_summary_ref:null, slot_updates:[], state_schema_version:"v1" },
  response:{ segments:["我可以先为您整理信息。"], citations:[], media_asset_ids:[], suggested_next_step:"" },
  handover:null,
  pending_action_preview:{ action_type:"unresolved_write", confirmation_required:true, external_effect:false },
  evidence:{ release_id:null, snapshot_id:null },
  policy:{ decision:"clarify", reason_code:"WRITE_CONFIRMATION_REQUIRED" }
};
assert.equal(assertLangGraphTurnDecision(decision, { stateSchemaVersion:"v1" }), decision);
assert.throws(
  () => assertLangGraphTurnDecision({ ...decision, pending_action_preview:{ ...decision.pending_action_preview, external_effect:true } }, { stateSchemaVersion:"v1" }),
  { code:"LANGGRAPH_PENDING_ACTION_UNSAFE" }
);
assert.throws(
  () => createLangGraphTurnRequest({ ...input, authorizationContext:"short" }),
  { code:"LANGGRAPH_CONTRACT_FIELD_INVALID" }
);

const config = readLangGraphOrchestratorConfig({
  HUAMEI_AGENT_ENGINE:"shadow",
  HUAMEI_LANGGRAPH_ORCHESTRATOR_URL:"http://127.0.0.1:4192",
  HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET:serviceSecret,
  HUAMEI_LANGGRAPH_THREAD_SECRET:threadSecret,
  HUAMEI_LANGGRAPH_SHADOW_ADMITTED:"true"
});
assert.equal(config.enabled, true);
const legacy = await requestLangGraphTurn(input, { env:{ HUAMEI_AGENT_ENGINE:"legacy" } });
assert.deepEqual(legacy, { used:false, reason:"legacy_engine", decision:null });
const unadmittedShadow = await requestLangGraphTurn(input, { env:{
  HUAMEI_AGENT_ENGINE:"shadow",
  HUAMEI_LANGGRAPH_ORCHESTRATOR_URL:"http://127.0.0.1:4192"
} });
assert.deepEqual(unadmittedShadow, { used:false, reason:"shadow_not_admitted", decision:null });
const delivery = await requestLangGraphTurn(input, { env:{
  HUAMEI_AGENT_ENGINE:"langgraph",
  HUAMEI_LANGGRAPH_ORCHESTRATOR_URL:"http://127.0.0.1:4192",
  HUAMEI_LANGGRAPH_SHADOW_ADMITTED:"true"
} });
assert.deepEqual(delivery, { used:false, reason:"langgraph_delivery_not_admitted", decision:null });

const migration = await readFile(new URL("../db/migrations/012_langgraph_turn_protocol.sql", import.meta.url), "utf8");
for (const term of ["agent_turn_results", "agent_effect_ledger", "agent_turn_leases", "handover_epoch", "fencing_counter"]) {
  assert.match(migration, new RegExp(term));
}

console.log("✓ LangGraph P0 契约、脱敏线程标识、服务令牌、非副作用中断与 Turn 协议迁移通过");
