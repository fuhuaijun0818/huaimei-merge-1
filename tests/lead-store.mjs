import assert from "node:assert/strict";

process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_APPOINTMENT_REGISTRATION_FILE = ":memory:";
// This suite creates a handover task under huamei-shanghai, so keep its
// implicit lead tenant aligned even when a developer shell selected another
// tenant for a running local application.
process.env.HUAMEI_DEFAULT_TENANT_ID = "huamei-shanghai";
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_IDENTITY_PEPPER = "lead_test_identity_P9o7I5u3Y1t8R6e4W2q0";
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

const {
  acquisitionCustomerSnapshot,
  completeAcquisitionTask,
  isValidMainlandMobile,
  leadDataClassification,
  normalizeMobile,
  recheckAcquisitionCustomerMember,
  resetLeadStoreForTest,
  updateAcquisitionCustomer,
  upsertAcquisitionLead
} = await import("../server/lead-store.mjs");
const { ensureHandoverTask, resetOperationsStoreForTest } = await import("../server/acquisition-operations-store.mjs");
const { resetDevelopmentContactVaultForTest } = await import("../server/contact-vault.mjs");
const { createAppointmentIntake } = await import("../server/appointment-intake-store.mjs");

resetLeadStoreForTest();
resetOperationsStoreForTest();
resetDevelopmentContactVaultForTest();
assert.equal(isValidMainlandMobile("+86 138-1234-5678"), true);
assert.equal(isValidMainlandMobile(" +86 138 1234 5678 "), true, "应先去除空格再规范化国家码");
assert.equal(isValidMainlandMobile("0086 138-1234-5678"), true, "0086 前缀也应识别为国内号码");
assert.equal(isValidMainlandMobile("＋86 138 1234 5678"), true, "全角加号应归一化");
assert.equal(normalizeMobile(" +86 138 1234 5678 "), "13812345678");
assert.equal(normalizeMobile("008613812345678"), "13812345678");
assert.equal(isValidMainlandMobile("1381234567890"), false, "多位数不能被截断成有效号码");
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

await ensureHandoverTask({
  envelope:{
    tenant_id:"huamei-shanghai", channel:"web", conversation_id:"format-valid-session-first",
    actor:{ external_user_id:"visitor-first" },
    message:{ id:"lead-store-pending-handover", text:"请人工顾问继续协助" }
  },
  result:{ status:"handover_required", handover:{ required:true, reason:"human_requested" } }
});
const presalesSnapshot = await acquisitionCustomerSnapshot("huamei-shanghai", {
  principal:{ subject:"presales-1", phaseOneRole:"售前顾问", departmentIds:["*"] }
});
assert.equal(presalesSnapshot.conversations.length, 1, "售前顾问应能看到尚未领取的转人工会话");
assert.equal(presalesSnapshot.conversations[0].externalConversationId, "format-valid-session-first");

const appointmentDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
await createAppointmentIntake({
  tenant_id:"huamei-shanghai", channel:"web", conversation_id:"format-valid-session-first",
  internal_customer_reference:"test-appointment-reference", source_action_id:"act_0123456789abcdef01234567",
  projects:["热玛吉"], branch:"上海华美医疗美容医院", preferred_date:appointmentDate,
  time_period:"afternoon", customer_confirmed:true
});
const snapshotWithAppointment = await acquisitionCustomerSnapshot("huamei-shanghai");
const appointmentCustomer = snapshotWithAppointment.customers.find((customer) => customer.id === first.lead.customer.id);
assert.equal(appointmentCustomer.appointment.time_preference, `${appointmentDate} 下午`);
assert.equal(appointmentCustomer.appointment.contact_status, undefined, "客户360投影不需要携带更多预约内部字段");
assert.equal(appointmentCustomer.timeline.some((event) => event.type === "appointment"), true);

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

const nameConflict = await upsertAcquisitionLead({
  mobile:"0086 138 1234 5678",
  name:"冲突测试客户",
  service_consent:true,
  session_id:"format-valid-session-name-conflict",
  interests:["光子嫩肤"],
  messages:[{ role:"user", content:"请安排人工顾问联系" }]
});
assert.equal(nameConflict.is_existing, true);
assert.equal(nameConflict.lead.customer.id, first.lead.customer.id);
assert.equal(nameConflict.lead.customer.name, "测试客户", "公共留资的冲突姓名不得自动覆盖既有档案");
assert.equal(nameConflict.lead.customer.nameConflicts.length, 1);
const capturedNameConflict = nameConflict.lead.customer.nameConflicts[0];
assert.match(capturedNameConflict.id, /^NC-/);
assert.equal(capturedNameConflict.status, "pending_manual");
assert.equal(capturedNameConflict.existing_name, "测试客户");
assert.equal(capturedNameConflict.submitted_name, "冲突测试客户");
assert.equal(capturedNameConflict.session_id, "format-valid-session-name-conflict");
assert.equal(capturedNameConflict.source, "获客顾问 Web");
assert.ok(Number.isFinite(Date.parse(capturedNameConflict.captured_at)));
assert.equal(nameConflict.lead.task.type, "人工资料复核");
assert.equal(nameConflict.lead.task.status, "待处理");
assert.match(nameConflict.lead.task.reason, /不同姓名/);
assert.equal(nameConflict.lead.customer.timeline[0].title, "姓名信息冲突，待人工复核");

const snapshot = await acquisitionCustomerSnapshot();
assert.equal(snapshot.customers.length, 1, "同租户相同格式化手机号沿用一个客户档案");
assert.ok(snapshot.customers[0].interests.some((item) => item.name === "光子嫩肤"));
assert.equal(snapshot.customers[0].phoneVerificationStatus, "pending_manual");
assert.equal(snapshot.meta.plaintext_mobile_stored, false);
assert.doesNotMatch(JSON.stringify(snapshot), /13812345678/);
assert.equal(leadDataClassification(first.lead), "production");

const memberCheckClient = {
  check:async ({ mobile, verification, previous }) => ({
    schema:"huamei.member-repeatcheck.v1", provider:"test_member_check", status:"checked",
    is_repeat:mobile === "13912345678", member_status:"unknown", reason_code:null,
    attempted_at:new Date().toISOString(), checked_at:new Date().toISOString(),
    capture_id:verification.verification_id, previous_result_reused:Boolean(previous)
  })
};
const profileUpdate = await updateAcquisitionCustomer({
  customer_id:first.lead.customer.id,
  expected_version:snapshot.customers[0].profileVersion,
  actor:"lead-store-test",
  patch:{
    name:"测试客户更正",
    mobile:" +86 139 1234-5678 ",
    profile:{ contact:"晚上联系" },
    contact_preferences:{ preferred_time:"晚上", do_not_contact:true },
    tags:["人工确认", "禁止电话"]
  }
}, { memberCheckClient });
assert.equal(profileUpdate.lead.customer.name, "测试客户更正");
assert.equal(profileUpdate.lead.customer.mobile, "139****5678");
assert.equal(profileUpdate.lead.customer.memberCheck.status, "checked", "电话变更必须使用新的会员查询结果");
assert.equal(profileUpdate.lead.customer.contactPreferences.do_not_contact, true);
assert.equal(profileUpdate.lead.customer.profileVersion, 2);
assert.equal(profileUpdate.lead.customer.timeline[0].actor, "lead-store-test");
const noteUpdate = await updateAcquisitionCustomer({
  customer_id:first.lead.customer.id,
  expected_version:profileUpdate.lead.customer.profileVersion,
  actor:"lead-store-note-author",
  patch:{ customer_note:"客户仅了解项目，暂不电话联系" }
});
const savedNote = noteUpdate.lead.customer.customerNotes[0];
assert.equal(savedNote.customer_id, first.lead.customer.id, "备注必须绑定当前客户档案");
assert.equal(savedNote.author, "lead-store-note-author", "备注必须保留服务端操作人");
assert.equal(savedNote.content, "客户仅了解项目，暂不电话联系");
assert.ok(Number.isFinite(Date.parse(savedNote.created_at)), "备注必须保留服务端保存时间");
assert.equal(noteUpdate.lead.customer.timeline[0].type, "note", "备注必须写入客户时间线");
await assert.rejects(
  () => updateAcquisitionCustomer({
    customer_id:first.lead.customer.id,
    expected_version:profileUpdate.lead.customer.profileVersion,
    actor:"lead-store-note-author",
    patch:{ customer_note:"客户仅了解项目，暂不电话联系" }
  }),
  (error) => error.code === "PROFILE_VERSION_CONFLICT",
  "重复提交同一旧版本不得添加第二条备注"
);
const noteSnapshot = await acquisitionCustomerSnapshot("huamei-shanghai");
assert.equal(noteSnapshot.customers.find((customer) => customer.id === first.lead.customer.id).customerNotes.length, 1, "重复提交后只能保留一条备注");
const qualitySnapshot = await acquisitionCustomerSnapshot("huamei-shanghai", {
  principal:{ subject:"quality-reviewer", phaseOneRole:"质量与运营人员", departmentIds:["*"] }
});
assert.equal(qualitySnapshot.meta.view, "quality_redacted", "质量角色必须收到服务端脱敏投影");
assert.equal(qualitySnapshot.customers.length, 0, "质量视图不得下发客户档案、联系方式、预约或备注");
assert.equal(qualitySnapshot.tasks.length, 0, "质量视图不得下发人工接待任务");
assert.equal(qualitySnapshot.conversations.length, 1, "全院范围的质量角色可查看已授权会话的脱敏投影");
assert.equal(qualitySnapshot.conversations[0].content_redacted, true);
assert.equal(qualitySnapshot.conversations[0].messages[0].text, "[会话内容已脱敏]");
assert.doesNotMatch(JSON.stringify(qualitySnapshot), /测试客户更正|139\*\*\*\*5678|客户仅了解项目|热玛吉和线雕有什么区别/,
  "质量视图不得包含客户称呼、联系方式、备注或会话原文");
const outOfScopeQualitySnapshot = await acquisitionCustomerSnapshot("huamei-shanghai", {
  principal:{ subject:"quality-reviewer-limited", phaseOneRole:"质量与运营人员", departmentIds:["皮肤科"] }
});
assert.equal(outOfScopeQualitySnapshot.conversations.length, 0, "未标记科室的会话不得对有限科室质检账号开放");
await assert.rejects(
  () => updateAcquisitionCustomer({ customer_id:first.lead.customer.id, expected_version:1, patch:{ name:"过期修改" } }),
  (error) => error.code === "PROFILE_VERSION_CONFLICT"
);

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

// 未配置院方接口时必须显示“未查询”，不能当作非会员，也不能丢掉留资。
const pendingLead = await upsertAcquisitionLead({
  tenant_id:"huamei-pending", mobile:"13612345678", service_consent:true, session_id:"pending-check-session"
});
assert.equal(pendingLead.member_check_status, "not_configured");
const pendingSnapshot = await acquisitionCustomerSnapshot("huamei-pending");
assert.equal(pendingSnapshot.customers[0].memberCheck.status, "not_configured", "未配置院方接口时标记未查询，而不是非会员");
assert.equal(pendingSnapshot.customers[0].memberCheck.is_repeat, null);
assert.equal(pendingSnapshot.customers[0].mobile, "136****5678", "未查询不得影响已保存联系信息");

// 禁止联系：不得再创建人工回访承诺，但已保存的号码与档案保持不变。
await assert.rejects(
  () => upsertAcquisitionLead({
    tenant_id:"huamei-shanghai", mobile:"13912345678", service_consent:true, session_id:"suppressed-session"
  }),
  (error) => error.code === "PRIVACY_CONTACT_SUPPRESSED",
  "禁止联系客户再次留资不得创建人工回访"
);
const afterSuppressed = await acquisitionCustomerSnapshot("huamei-shanghai");
assert.equal(afterSuppressed.customers[0].mobile, "139****5678", "禁止联系不影响已保存的联系信息");
assert.equal(afterSuppressed.customers[0].name, "测试客户更正");

// 人工重查：使用当前 capture 的号码重新查询，并写入时间线审计。
const recheckClient = {
  check:async ({ mobile, verification }) => ({
    schema:"huamei.member-repeatcheck.v1", provider:"test_member_check", status:"checked",
    is_repeat:true, member_status:"unknown", reason_code:null, result_semantics:"duplicate_only",
    attempted_at:new Date().toISOString(), checked_at:new Date().toISOString(),
    capture_id:verification.verification_id, queried_mobile_suffix:mobile.slice(-4)
  })
};
const rechecked = await recheckAcquisitionCustomerMember(
  { tenant_id:"huamei-shanghai", customer_id:first.lead.customer.id, actor:"lead-store-test" },
  { memberCheckClient:recheckClient }
);
assert.equal(rechecked.member_check_status, "checked");
assert.equal(rechecked.lead.customer.memberCheck.is_repeat, true);
assert.equal(rechecked.lead.customer.memberCheck.queried_mobile_suffix, "5678", "重查必须使用当前手机号");
assert.equal(rechecked.lead.customer.timeline[0].title, "人工触发院方会员状态重查");
assert.equal(rechecked.lead.customer.timeline[0].actor, "lead-store-test");

let receivedPrevious;
const retryAwareRecheckClient = {
  check:async ({ previous, verification }) => {
    receivedPrevious = previous;
    return {
      schema:"huamei.member-repeatcheck.v1", provider:"test_member_check", status:"failed",
      is_repeat:null, member_status:"unknown", reason_code:"RETRY_EXHAUSTED",
      retry_count:3, next_retry_at:null, attempted_at:new Date().toISOString(), checked_at:null,
      capture_id:verification.verification_id
    };
  }
};
await recheckAcquisitionCustomerMember(
  { tenant_id:"huamei-shanghai", customer_id:first.lead.customer.id, actor:"lead-store-test" },
  { memberCheckClient:retryAwareRecheckClient }
);
assert.equal(receivedPrevious?.retry_count, undefined, "a successful result has no failure budget");
const exhaustedRecheck = await recheckAcquisitionCustomerMember(
  { tenant_id:"huamei-shanghai", customer_id:first.lead.customer.id, actor:"lead-store-test" },
  { memberCheckClient:retryAwareRecheckClient }
);
assert.equal(receivedPrevious?.retry_count, 3, "a later manual retry receives the persisted failure budget");
assert.equal(exhaustedRecheck.member_check.reason_code, "RETRY_EXHAUSTED");

// 旧号码的查询结果不能覆盖已变更的新号码状态。
let releaseStaleCheck;
let staleCheckStarted;
const staleCheckStarted$ = new Promise((resolve) => { staleCheckStarted = resolve; });
const staleClient = {
  check:() => {
    staleCheckStarted();
    return new Promise((resolve) => {
      releaseStaleCheck = () => resolve({
        schema:"huamei.member-repeatcheck.v1", provider:"test_member_check", status:"checked",
        is_repeat:false, member_status:"unknown", reason_code:null, result_semantics:"duplicate_only",
        attempted_at:new Date().toISOString(), checked_at:new Date().toISOString(), capture_id:"stale"
      });
    });
  }
};
const staleRecheck = recheckAcquisitionCustomerMember(
  { tenant_id:"huamei-shanghai", customer_id:first.lead.customer.id, actor:"lead-store-test" },
  { memberCheckClient:staleClient }
);
await staleCheckStarted$;
const rotated = await updateAcquisitionCustomer({
  customer_id:first.lead.customer.id,
  expected_version:rechecked.lead.customer.profileVersion,
  actor:"lead-store-test",
  patch:{ mobile:"13712340000" }
}, { memberCheckClient:recheckClient });
assert.equal(rotated.lead.customer.mobile, "137****0000");
releaseStaleCheck();
await assert.rejects(
  () => staleRecheck,
  (error) => error.code === "MEMBER_CHECK_CAPTURE_STALE"
);
const afterStale = await acquisitionCustomerSnapshot("huamei-shanghai");
assert.equal(afterStale.customers[0].memberCheck.is_repeat, true, "旧号码结果不得覆盖新号码状态");
assert.equal(afterStale.customers[0].memberCheck.queried_mobile_suffix, "0000", "保留新号码的查询结果");

const completedTask = await completeAcquisitionTask({
  tenant_id:"huamei-shanghai",
  task_id:first.lead.task.id,
  customer_id:first.lead.customer.id,
  actor:"lead-store-test"
});
assert.equal(completedTask.task.status, "已完成");
assert.equal(completedTask.replayed, false);
const replayedTask = await completeAcquisitionTask({
  tenant_id:"huamei-shanghai",
  task_id:first.lead.task.id,
  customer_id:first.lead.customer.id,
  actor:"lead-store-test"
});
assert.equal(replayedTask.replayed, true, "重复完成必须幂等");
const afterTaskCompletion = await acquisitionCustomerSnapshot("huamei-shanghai");
assert.equal(
  afterTaskCompletion.tasks.find((item) => item.id === first.lead.task.id)?.status,
  "已完成",
  "任务完成状态必须写入服务端快照，刷新后不能回到待处理"
);
assert.ok(completedTask.lead.customer.timeline.some((item) => item.type === "task" && String(item.title).startsWith("任务完成：")));

console.log("✓ 手机号格式校验后直接留资、待人工核号、租户隔离、同号归并与姓名冲突人工复核、禁止联系与人工重查通过");
