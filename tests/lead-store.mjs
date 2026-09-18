import assert from "node:assert/strict";

process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_IDENTITY_PEPPER = "lead_test_identity_P9o7I5u3Y1t8R6e4W2q0";
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

const {
  acquisitionCustomerSnapshot,
  isValidMainlandMobile,
  leadDataClassification,
  resetLeadStoreForTest,
  upsertAcquisitionLead
} = await import("../server/lead-store.mjs");

resetLeadStoreForTest();
assert.equal(isValidMainlandMobile("+86 138-1234-5678"), true);
assert.equal(isValidMainlandMobile("12345"), false);

const first = await upsertAcquisitionLead({
  mobile:"13812345678",
  name:"测试客户",
  service_consent:true,
  session_id:"format-valid-session-first",
  interests:["热玛吉", "线雕提升"],
  messages:[
    { role:"user", content:"热玛吉和线雕有什么区别？" },
    { role:"assistant", content:"这里是一般项目知识讲解。" }
  ]
});
assert.equal(first.verification_status, "pending_manual");
assert.equal(first.is_existing, false);
assert.match(first.lead.customer.id, /^C-AI-/);
assert.equal(first.lead.customer.mobile, "138****5678");
assert.equal(first.lead.customer.phoneVerificationStatus, "pending_manual");
assert.equal(first.contact.phone_verification_status, "pending_manual");
assert.equal(first.lead.customer.marketingConsent, false);

const second = await upsertAcquisitionLead({
  mobile:"+86 138 1234 5678",
  service_consent:true,
  session_id:"format-valid-session-second",
  interests:["光子嫩肤"],
  messages:[{ role:"user", content:"还想了解光子嫩肤" }]
});
assert.equal(second.verification_status, "pending_manual");
assert.equal(second.is_existing, true);
assert.equal(second.lead.customer.id, first.lead.customer.id);
assert.equal(second.lead.customer.name, "测试客户");
assert.equal(second.lead.interactions, 2);
assert.equal(second.lead.conversations.length, 2);

const snapshot = await acquisitionCustomerSnapshot();
assert.equal(snapshot.customers.length, 1, "同租户相同格式化手机号沿用一个客户档案");
assert.ok(snapshot.customers[0].interests.some((item) => item.name === "光子嫩肤"));
assert.equal(snapshot.customers[0].phoneVerificationStatus, "pending_manual");
assert.equal(snapshot.meta.plaintext_mobile_stored, false);
assert.doesNotMatch(JSON.stringify(snapshot), /13812345678/);
assert.equal(leadDataClassification(first.lead), "production");

const otherTenant = await upsertAcquisitionLead({
  tenant_id:"huamei-second",
  mobile:"13812345678",
  service_consent:true,
  session_id:"second-tenant-session"
});
assert.equal(otherTenant.is_existing, false, "相同手机号不得跨租户合并客户档案");
assert.equal((await acquisitionCustomerSnapshot("huamei-second")).customers.length, 1);

const unnamed = await upsertAcquisitionLead({
  tenant_id:"huamei-unnamed", mobile:"13912345678", service_consent:true, session_id:"unnamed-lead"
});
assert.equal(unnamed.lead.customer.name, "", "空姓名必须保留为空，不得拼接手机号尾号");

await assert.rejects(
  () => upsertAcquisitionLead({ mobile:"12345", service_consent:true }),
  (error) => error.code === "INVALID_MOBILE"
);
await assert.rejects(
  () => upsertAcquisitionLead({ mobile:"13912345678", service_consent:false }),
  (error) => error.code === "SERVICE_CONSENT_REQUIRED"
);

console.log("✓ 手机号格式校验后直接留资、待人工核号、租户隔离和同号归并通过");
