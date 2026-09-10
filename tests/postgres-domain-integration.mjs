import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

if (String(process.env.HUAMEI_PERSISTENCE_BACKEND || "").toLowerCase() !== "postgres") {
  throw new Error("该集成测试必须显式设置 HUAMEI_PERSISTENCE_BACKEND=postgres");
}
const databaseUrl = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "");
if (!databaseUrl) throw new Error("该集成测试需要 HUAMEI_DATABASE_URL");

const tenantId = `it-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const sessionId = `${tenantId}:api:conversation-1`;
const checksumA = "a".repeat(64);
const checksumB = "b".repeat(64);
process.env.HUAMEI_LLM_ENABLED = "false";
process.env.HUAMEI_CONTACT_VAULT_KEYRING_JSON = JSON.stringify({
  active_key_id:"domain-contact-v1",
  keys:{ "domain-contact-v1":randomBytes(32).toString("base64") }
});

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { createPostgresAcquisitionSessionStore } = await import("../server/persistence/postgres-session-store.mjs");
const { createPostgresOperationsStore } = await import("../server/persistence/postgres-operations-store.mjs");
const { createPostgresLeadStore } = await import("../server/persistence/postgres-lead-store.mjs");
const { createPostgresKnowledgeReleaseStore } = await import("../server/persistence/postgres-knowledge-release-store.mjs");
const { createPostgresAgentRunStore } = await import("../server/persistence/postgres-agent-run-store.mjs");
const { prepareAcquisitionSessionContext, recordAcquisitionSessionTurn } = await import("../server/acquisition-session.mjs");
const { upsertAcquisitionLead, acquisitionCustomerSnapshot } = await import("../server/lead-store.mjs");
const {
  activateKnowledgeRelease,
  attachKnowledgeIndex,
  createKnowledgeReleaseDraft,
  getKnowledgeAdmissionStatus,
  getKnowledgeReleaseReceipt,
  getKnowledgeReviewScope,
  initializeKnowledgeReleasePolicy,
  submitKnowledgeReview
} = await import("../server/knowledge-release-policy.mjs");
const { invokeAgentAsync } = await import("../server/agent-runtime.mjs");

const clientA = createPostgresClient({ connectionString:databaseUrl, applicationName:"huamei-integration-a" });
const clientB = createPostgresClient({ connectionString:databaseUrl, applicationName:"huamei-integration-b" });

try {
  const context = await prepareAcquisitionSessionContext(
    sessionId,
    "我想做双眼皮，预算一万左右，希望自然一点",
    [],
    { tenantId, channel:"api", externalConversationId:"conversation-1", inboundMessageId:"it-message-1" }
  );
  assert.equal(context.known_slots.budget, "一万");
  await recordAcquisitionSessionTurn(sessionId, {
    message:"我想做双眼皮，预算一万左右，希望自然一点",
    result:{
      status:"completed",
      output:{
        message:"了解，您希望自然一些。\n我先按双眼皮方向为您介绍。",
        citations:[{ source_record_id:"KB-P-TEST" }],
        structured_data:{ intent:"project_consult", intent_analysis:{ primary_intent:"project_consult", entities:{ projects:["双眼皮"] } } }
      }
    },
    projects:["双眼皮"]
  }, { tenantId, channel:"api", externalConversationId:"conversation-1", inboundMessageId:"it-message-1" });

  const replicaBSession = createPostgresAcquisitionSessionStore({ postgres:clientB });
  const sessionFromReplicaB = await replicaBSession.get({ tenantId, sessionId, channel:"api" });
  assert.equal(sessionFromReplicaB.projects.includes("双眼皮"), true);
  assert.equal(sessionFromReplicaB.counters.completed, 1);

  const lead = await upsertAcquisitionLead({
    tenant_id:tenantId,
    session_id:"conversation-1",
    mobile:"13912345678",
    name:"集成测试客户",
    service_consent:true,
    marketing_consent:false,
    interests:["双眼皮"],
    messages:[{ role:"user", content:"想了解双眼皮", at:new Date().toISOString() }]
  });
  assert.equal(lead.is_existing, false);
  assert.match(lead.lead.customer.mobile, /^139\*{4}5678$/);
  const snapshot = await acquisitionCustomerSnapshot(tenantId);
  assert.equal(snapshot.meta.total, 1);
  assert.equal(JSON.stringify(snapshot).includes("13912345678"), false);

  const concurrentLeadCount = 20;
  const concurrentMobile = "13800005678";
  const concurrentLeads = await Promise.all(Array.from({ length:concurrentLeadCount }, (_, index) => upsertAcquisitionLead({
    tenant_id:tenantId,
    session_id:`concurrent-first-${index + 1}`,
    mobile:concurrentMobile,
    name:"并发留资客户",
    service_consent:true,
    marketing_consent:index % 2 === 0,
    interests:[index % 2 === 0 ? "光子嫩肤" : "双眼皮"],
    messages:[{ role:"user", content:`第${index + 1}次并发咨询`, at:new Date().toISOString() }]
  })));
  assert.equal(concurrentLeads.filter((item) => item.is_existing === false).length, 1, "首次并发留资只能创建一个客户");
  assert.equal(concurrentLeads.filter((item) => item.is_existing === true).length, concurrentLeadCount - 1);
  const leadReplicaB = createPostgresLeadStore({ postgres:clientB });
  const concurrentStoredLead = (await leadReplicaB.snapshot(tenantId))
    .find((item) => item.customer?.mobile === "138****5678");
  assert.ok(concurrentStoredLead, "并发留资后的客户档案必须可跨副本读取");
  assert.equal(concurrentStoredLead.interactions, concurrentLeadCount, "并发互动次数不得丢失");
  assert.equal(concurrentStoredLead.conversations.length, concurrentLeadCount, "并发会话不得丢失");
  assert.equal(new Set(concurrentStoredLead.conversations.map((item) => item.id)).size, concurrentLeadCount, "并发会话不得重复");
  const consentEvidence = await clientB.tenantQuery(tenantId,
    `SELECT c.consent_type,
       count(*)::int AS total,
       count(*) FILTER (WHERE c.is_current)::int AS current_count
     FROM consents c
     JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
     WHERE c.tenant_id=$1 AND l.masked_mobile=$2
     GROUP BY c.consent_type
     ORDER BY c.consent_type`,
    [tenantId, "138****5678"]
  );
  assert.deepEqual(consentEvidence.rows, [
    { consent_type:"marketing", total:concurrentLeadCount, current_count:1 },
    { consent_type:"service", total:concurrentLeadCount, current_count:1 }
  ], "每次授权证据必须完整留存，且每类只能有一个当前版本");

  const operationsA = createPostgresOperationsStore({ postgres:clientA });
  const operationsB = createPostgresOperationsStore({ postgres:clientB });
  const envelope = {
    tenant_id:tenantId,
    channel:"api",
    conversation_id:"conversation-1",
    actor:{ external_user_id:"test-user", customer_id:null },
    message:{ id:"risk-1", text:"我适不适合做？" }
  };
  const handover = await operationsA.ensureHandoverTask({
    envelope,
    result:{ status:"handover_required", handover:{ required:true, reason:"suitability_judgement", to_team:"人工咨询" } },
    sessionSnapshot:{ conversation_summary:"客户询问适用性", known_slots:{}, projects:["双眼皮"] },
    contactInitiation:"customer_inbound",
    safeText:(value, limit = 500) => String(value || "").slice(0, limit)
  });
  assert.match(handover.id, /^ho_/);
  const handoverFromReplicaB = await operationsB.findOpenHandover({ tenantId, channel:"api", conversationId:"conversation-1" });
  assert.equal(handoverFromReplicaB.id, handover.id);
  const claimContenders = ["测试顾问", "其他顾问"];
  const claimOutcomes = await Promise.allSettled([
    operationsA.claimHandover({ handoverId:handover.id, tenantId, assignee:claimContenders[0] }),
    operationsB.claimHandover({ handoverId:handover.id, tenantId, assignee:claimContenders[1] })
  ]);
  const successfulClaims = claimOutcomes.filter((item) => item.status === "fulfilled");
  const rejectedClaims = claimOutcomes.filter((item) => item.status === "rejected");
  assert.equal(successfulClaims.length, 1, "两个副本同时抢单只能有一个成功");
  assert.equal(rejectedClaims.length, 1);
  assert.equal(rejectedClaims[0].reason.code, "HANDOVER_ALREADY_CLAIMED");
  const claimedHandover = successfulClaims[0].value;
  const winningAssignee = claimedHandover.assignee;
  const losingAssignee = claimContenders.find((item) => item !== winningAssignee);
  assert.equal(claimedHandover.status, "active");
  const claimRetry = await operationsA.claimHandover({ handoverId:handover.id, tenantId, assignee:winningAssignee });
  assert.equal(claimRetry.claimed_at, claimedHandover.claimed_at, "同一顾问跨副本重试不得重复领取");
  await assert.rejects(
    () => operationsA.claimHandover({ handoverId:handover.id, tenantId, assignee:losingAssignee }),
    (error) => error.code === "HANDOVER_ALREADY_CLAIMED"
  );
  await assert.rejects(
    () => operationsA.completeHandoverWithWork({ handoverId:handover.id, tenantId, actor:losingAssignee, resolution:"不应成功", minutes:1 }),
    (error) => error.code === "HANDOVER_ASSIGNEE_MISMATCH"
  );
  const handoverInboundEnvelope = {
    ...envelope,
    message:{ id:"handover-inbound-1", text:"人工顾问接管后我再补充一个问题" }
  };
  const safeInboundText = (value, limit = 500) => String(value || "").slice(0, limit);
  assert.equal((await operationsA.recordInbound(handover, handoverInboundEnvelope, safeInboundText)).duplicate, false);
  assert.equal((await operationsB.recordInbound(handover, handoverInboundEnvelope, safeInboundText)).duplicate, true);
  const handoverInboundEvidence = await clientA.tenantQuery(tenantId,
    `SELECT
       (SELECT count(*) FROM conversation_messages m
        WHERE m.tenant_id=$1 AND m.message_id=$2)::int AS messages,
       (SELECT count(*) FROM audit_events a
        WHERE a.tenant_id=$1 AND a.resource_id=$3
          AND a.action='handover.inbound_received')::int AS audits,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=$1 AND o.aggregate_id=$3
          AND o.event_type='handover.inbound_received')::int AS outbox_events`,
    [tenantId, handoverInboundEnvelope.message.id, handover.id]
  );
  assert.deepEqual(handoverInboundEvidence.rows[0], {
    messages:1,
    audits:1,
    outbox_events:1
  }, "人工接管期间相同message.id跨副本重放必须只落一次消息、审计和Outbox");
  const atomicCompletion = await operationsA.completeHandoverWithWork({
    handoverId:handover.id, tenantId, actor:winningAssignee,
    resolution:"已说明", minutes:3.5, notes:"完成跨副本人工接管"
  });
  assert.equal(atomicCompletion.handover.status, "completed");
  assert.equal(atomicCompletion.human_work.minutes, 3.5);
  const atomicCompletionRetry = await operationsB.completeHandoverWithWork({
    handoverId:handover.id, tenantId, actor:winningAssignee,
    resolution:"已说明", minutes:3.5, notes:"完成跨副本人工接管"
  });
  assert.equal(atomicCompletionRetry.replayed, true);
  assert.equal(atomicCompletionRetry.human_work.id, atomicCompletion.human_work.id);
  await assert.rejects(
    () => operationsB.completeHandoverWithWork({ handoverId:handover.id, tenantId, actor:losingAssignee, resolution:"不应覆盖", minutes:2 }),
    (error) => error.code === "HANDOVER_ASSIGNEE_MISMATCH"
  );
  const handoverWriteEvidence = await clientA.tenantQuery(tenantId,
    `SELECT h.status, h.assignee, t.status AS task_status, t.assignee AS task_assignee,
       (SELECT count(*) FROM audit_events a
        WHERE a.tenant_id=h.tenant_id AND a.resource_id=h.handover_id AND a.action='handover.claimed')::int AS claim_audits,
       (SELECT count(*) FROM audit_events a
        WHERE a.tenant_id=h.tenant_id AND a.resource_id=h.handover_id AND a.action='handover.completed_with_work')::int AS complete_audits,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=h.tenant_id AND o.aggregate_id=h.handover_id AND o.event_type='handover.claimed')::int AS claim_events,
       (SELECT count(*) FROM outbox_events o
        WHERE o.tenant_id=h.tenant_id AND o.aggregate_id=h.handover_id AND o.event_type='handover.completed_with_work')::int AS complete_events,
       (SELECT count(*) FROM human_work w
        WHERE w.tenant_id=h.tenant_id AND w.handover_record_id=h.id AND w.work_type='handover_completion')::int AS completion_work_records
     FROM handovers h
     JOIN tasks t ON t.tenant_id=h.tenant_id AND t.handover_record_id=h.id
     WHERE h.tenant_id=$1 AND h.handover_id=$2`,
    [tenantId, handover.id]
  );
  assert.deepEqual(handoverWriteEvidence.rows[0], {
    status:"completed",
    assignee:winningAssignee,
    task_status:"completed",
    task_assignee:winningAssignee,
    claim_audits:1,
    complete_audits:1,
    claim_events:1,
    complete_events:1,
    completion_work_records:1
  }, "并发抢单与幂等重试只能产生一次状态变更、审计和Outbox事件");
  assert.equal((await operationsA.metrics(tenantId)).human_work_minutes, 3.5);

  const releaseId = `krel_${randomUUID()}`;
  const packageVersion = `it-${Date.now()}`;
  const indexVersion = `it-index-${Date.now()}`;
  await createKnowledgeReleaseDraft({
    tenant_id:tenantId,
    release_id:releaseId,
    package_version:packageVersion,
    package_checksum:checksumA,
    record_list_checksum:"c".repeat(64),
    index_version:indexVersion,
    approved_record_ids:["KB-P-TEST"],
  }, {
    subject:"release-manager-it", roles:["knowledge.release_manager"],
    tenantIds:[tenantId], issuer:"https://identity.test", tokenId:"token-release-manager"
  });
  const reviewScope = await getKnowledgeReviewScope(tenantId, releaseId);
  const reviewerTypes = ["business", "medical", "compliance"];
  for (const reviewType of reviewerTypes) {
    await submitKnowledgeReview({
      tenant_id:tenantId,
      release_id:releaseId,
      review_type:reviewType,
      decision:"approved",
      scope_checksum:reviewScope.scope_checksum,
      comments:`${reviewType} integration approval`
    }, {
      subject:`reviewer-${reviewType}-it`, roles:[`knowledge.${reviewType}_reviewer`],
      tenantIds:[tenantId], issuer:"https://identity.test", tokenId:`token-${reviewType}`
    });
  }
  const receipt = await getKnowledgeReleaseReceipt(tenantId, releaseId);
  const officialManifest = {
    schema_version:"huamei.graphrag.index-manifest.v1",
    index_version:indexVersion,
    manifest_sha256:checksumB,
    release_binding:{ ...receipt, approval_receipt_sha256:"d".repeat(64) }
  };
  await attachKnowledgeIndex({
    tenant_id:tenantId, release_id:releaseId, index_checksum:checksumB, manifest:officialManifest
  }, {
    subject:"index-manager-it", roles:["knowledge.index_manager"],
    tenantIds:[tenantId], issuer:"https://identity.test", tokenId:"token-index"
  });
  const release = await activateKnowledgeRelease({ tenant_id:tenantId, release_id:releaseId }, {
    subject:"publisher-it", roles:["knowledge.publisher"],
    tenantIds:[tenantId], issuer:"https://identity.test", tokenId:"token-publisher"
  });
  await initializeKnowledgeReleasePolicy(tenantId);
  assert.equal(release.status, "active");
  assert.equal(getKnowledgeAdmissionStatus(tenantId, release.package_version).ready, true);
  const releaseReplicaB = createPostgresKnowledgeReleaseStore({ postgres:clientB });
  await releaseReplicaB.refresh(tenantId);
  const persistedKnowledgeRelease = releaseReplicaB.list(tenantId)[0];
  assert.equal(persistedKnowledgeRelease.index_checksum, checksumB);
  assert.equal(persistedKnowledgeRelease.manifest.manifest_sha256, checksumB);

  const agentResponse = await invokeAgentAsync("A-06", {
    message:"这段宣传文案保证效果、零风险",
    mode:"assist",
    channel:"api",
    context:{ tenant_id:tenantId }
  }, { requestId:`req_${randomUUID()}`, caller:"postgres-integration" });
  assert.equal(agentResponse.status, "blocked");
  const agentRunsReplicaB = createPostgresAgentRunStore({ postgres:clientB });
  const persistedRun = await agentRunsReplicaB.get(agentResponse.run_id, tenantId);
  assert.equal(persistedRun.audit.run_id, agentResponse.run_id);
  assert.equal(persistedRun.audit.status, "blocked");

  const evidence = await clientA.tenantQuery(tenantId,
    `SELECT
      (SELECT count(*) FROM audit_events WHERE tenant_id=$1)::int AS audit_count,
      (SELECT count(*) FROM outbox_events WHERE tenant_id=$1)::int AS outbox_count,
      (SELECT count(*) FROM consents WHERE tenant_id=$1 AND is_current)::int AS current_consents`,
    [tenantId]
  );
  assert.ok(evidence.rows[0].audit_count >= 4);
  assert.ok(evidence.rows[0].outbox_count >= 4);
  assert.equal(evidence.rows[0].current_consents, 4, "两个客户各保留服务与营销两类当前授权");
  console.log(`✓ PostgreSQL多副本会话、线索、转人工、工时、知识三审、审计与Outbox集成通过（${tenantId}）`);
} finally {
  await Promise.allSettled([clientA.close(), clientB.close(), closePostgresClient()]);
}
