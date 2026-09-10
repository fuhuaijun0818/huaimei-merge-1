import assert from "node:assert/strict";

process.env.HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE = ":memory:";
const {
  getManagementDomainOverlay,
  replaceManagementDomainOverlay
} = await import(`../server/management-domain-store.mjs?management-domain-store=${Date.now()}`);

const initial = getManagementDomainOverlay({ tenantId:"huamei-shanghai" });
assert.equal(initial.revision, 0);
assert.deepEqual(initial.overlay.customers, []);
assert.deepEqual(initial.overlay.conversations, []);
assert.deepEqual(initial.overlay.productOverrides, []);

const overlay = {
  ...initial.overlay,
  customers:[{
    id:"C-local-1",
    name:"本地客户",
    mobile:"13800000000",
    timeline:[],
    interests:[],
    pains:[],
    itches:[],
    delights:[],
    journeys:[],
    profile:{},
    nextAction:{ title:"待人工制定" }
  }],
  conversations:[{
    id:"V-local-1",
    customerId:"C-local-1",
    messages:[],
    channel:"官网",
    status:"待人工",
    mode:"人工"
  }],
  productOverrides:[{
    id:"product-local-1",
    name:"运营新建产品",
    price:"¥5,980",
    priceApprovalStatus:"待审核"
  }],
  configurationRecords:[{
    id:"CFG-local-1",
    kind:"message_template",
    name:"本地话术模板",
    status:"草稿",
    scope:"首次咨询",
    content:"您好，请问您想了解哪个项目？"
  }],
  audit:[{
    id:"L-local-1",
    at:"2026-08-31T10:00:00.000Z",
    action:"本地测试",
    object:"C-local-1",
    result:"成功",
    severity:"低"
  }]
};

const saved = replaceManagementDomainOverlay({
  tenantId:"huamei-shanghai",
  expectedRevision:0,
  overlay,
  actor:"local-test",
  idempotencyKey:"management-overlay-test-001"
});
assert.equal(saved.revision, 1);
assert.equal(saved.replayed, false);
assert.equal(saved.overlay.customers[0].id, "C-local-1");

const replay = replaceManagementDomainOverlay({
  tenantId:"huamei-shanghai",
  expectedRevision:0,
  overlay,
  actor:"local-test",
  idempotencyKey:"management-overlay-test-001"
});
assert.equal(replay.replayed, true, "相同幂等键必须回放原操作结果");
assert.equal(replay.revision, 1);

const reloaded = getManagementDomainOverlay({ tenantId:"huamei-shanghai" });
assert.equal(reloaded.revision, 1);
assert.equal(reloaded.overlay.conversations[0].customerId, "C-local-1");
assert.equal(reloaded.overlay.productOverrides[0].price, "¥5,980");
assert.equal(reloaded.overlay.configurationRecords[0].name, "本地话术模板");

assert.throws(() => replaceManagementDomainOverlay({
  tenantId:"huamei-shanghai",
  expectedRevision:0,
  overlay,
  actor:"local-test",
  idempotencyKey:"management-overlay-test-002"
}), (error) => error.code === "MANAGEMENT_REVISION_CONFLICT");

assert.throws(() => replaceManagementDomainOverlay({
  tenantId:"huamei-shanghai",
  expectedRevision:1,
  overlay:{ ...overlay, unexpectedField:[] },
  actor:"local-test",
  idempotencyKey:"management-overlay-test-003"
}), (error) => error.code === "MANAGEMENT_OVERLAY_FIELD_FORBIDDEN");

console.log("✓ 管理后台服务端覆盖层的空基线、持久化、幂等与并发冲突保护通过");
