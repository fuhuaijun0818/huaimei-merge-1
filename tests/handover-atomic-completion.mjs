import assert from "node:assert/strict";

const originalBackend = process.env.HUAMEI_PERSISTENCE_BACKEND;
const originalStore = process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";

try {
  const {
    claimHandover,
    completeHandoverWithWork,
    ensureHandoverTask,
    getHandover,
    getOperationsMetrics,
    resetOperationsStoreForTest
  } = await import(`../server/acquisition-operations-store.mjs?atomic-completion=${Date.now()}`);
  resetOperationsStoreForTest();
  const tenantId = "tenant-atomic";
  const handover = await ensureHandoverTask({
    envelope:{
      tenant_id:tenantId,
      channel:"web",
      conversation_id:"conversation-atomic",
      actor:{ external_user_id:"anonymous-user" },
      message:{ id:"message-atomic", text:"需要人工处理" }
    },
    result:{ status:"handover_required", handover:{ required:true, reason:"medical_safety", to_team:"人工咨询" } },
    session_snapshot:{ conversation_summary:"医疗边界问题需人工继续沟通" }
  });
  await claimHandover(handover.id, { tenant_id:tenantId, assignee:"advisor-atomic" });

  assert.throws(
    () => completeHandoverWithWork(handover.id, {
      tenant_id:tenantId,
      actor:"advisor-other",
      resolution:"不应成功",
      minutes:2
    }),
    (error) => error.code === "HANDOVER_ASSIGNEE_MISMATCH"
  );
  assert.equal((await getHandover(handover.id, tenantId)).status, "active");
  assert.equal((await getOperationsMetrics(tenantId)).human_work_records, 0);

  const payload = {
    tenant_id:tenantId,
    actor:"advisor-atomic",
    resolution:"已完成人工说明",
    minutes:3.25,
    notes:"电话跟进"
  };
  const completed = await completeHandoverWithWork(handover.id, payload);
  assert.equal(completed.handover.status, "completed");
  assert.equal(completed.handover.ai_suspended, false);
  assert.equal(completed.human_work.staff_id, "advisor-atomic");
  assert.equal(completed.human_work.minutes, 3.25);
  assert.equal(completed.replayed, false);

  const replayed = await completeHandoverWithWork(handover.id, payload);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.human_work.id, completed.human_work.id);
  const replayMetrics = await getOperationsMetrics(tenantId);
  assert.equal(replayMetrics.handovers_completed, 1);
  assert.equal(replayMetrics.human_work_minutes, 3.25);
  assert.equal(replayMetrics.human_work_records, 1);

  assert.throws(
    () => completeHandoverWithWork(handover.id, { ...payload, minutes:9 }),
    (error) => error.code === "HANDOVER_COMPLETION_PAYLOAD_MISMATCH"
  );
  const metrics = await getOperationsMetrics(tenantId);
  assert.equal(metrics.handovers_completed, 1);
  assert.equal(metrics.human_work_minutes, 3.25);
  assert.equal(metrics.human_work_records, 1, "原子完结重试不能重复登记工时");

  console.log("✓ 接管完结与实名工时单事务、重试幂等和载荷冲突保护通过");
} finally {
  if (originalBackend === undefined) delete process.env.HUAMEI_PERSISTENCE_BACKEND;
  else process.env.HUAMEI_PERSISTENCE_BACKEND = originalBackend;
  if (originalStore === undefined) delete process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE;
  else process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = originalStore;
}
