import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.HUAMEI_HR_STORE_FILE = ":memory:";
const hr = await import("../server/hr-operations.mjs");
const feishuReports = await import("../server/feishu-report-client.mjs");

const today = new Date().toISOString().slice(0, 10);
const tenantId = "tenant-hr-test";
const actor = "hr-admin-test";

const onboarding = await hr.createOnboardingWorkflow({
  tenantId,
  actor,
  payload:{
    name:"测试员工甲",
    account_id:"employee.one@example.test",
    department:"客户运营部",
    position:"运营专员",
    start_date:today,
    manager:"测试负责人",
    mobile:"13800000000",
    email:"employee@example.test"
  }
});
assert.equal(onboarding.type, "onboarding");
assert.equal(onboarding.tasks.length, 6);
assert.equal(onboarding.employee.status, "待入职");
assert.ok(onboarding.tasks.some((task) => task.external), "入职流程必须标记外部账号动作");

await assert.rejects(
  hr.createOnboardingWorkflow({
    tenantId,
    actor,
    payload:{ name:"测试员工甲", account_id:"another.account@example.test", department:"客户运营部", position:"运营专员", start_date:today }
  }),
  (error) => error.code === "HR_ONBOARDING_DUPLICATE"
);

let currentOnboarding = onboarding;
for (const task of onboarding.tasks) {
  currentOnboarding = await hr.completeHrTask({
    tenantId,
    actor,
    workflowId:onboarding.id,
    taskId:task.id,
    note:"测试完成",
    externalReference:task.external ? "IT工单 TEST-001 已核验" : ""
  });
}
assert.equal(currentOnboarding.status, "completed");
assert.equal(currentOnboarding.employee.status, "在职");
const afterOnboarding = await hr.getHrOverview({ tenantId, actor });
assert.equal(afterOnboarding.employees.find((item) => item.id === onboarding.employee.id).status, "在职", "流程完成后员工列表状态必须同步为在职");

const offboarding = await hr.createOffboardingWorkflow({
  tenantId,
  actor,
  payload:{
    employee_id:onboarding.employee.id,
    last_working_date:today,
    reason:"自动流程测试",
    handover_to:"接任员工"
  }
});
assert.equal(offboarding.type, "offboarding");
assert.equal(offboarding.tasks.length, 6);
assert.equal(offboarding.employee.status, "待离职");

const externalTask = offboarding.tasks.find((task) => task.external);
assert.ok(externalTask);
await assert.rejects(
  hr.completeHrTask({
    tenantId,
    actor,
    workflowId:offboarding.id,
    taskId:externalTask.id,
    note:"未提供核验凭据"
  }),
  (error) => error.code === "HR_EXTERNAL_EVIDENCE_REQUIRED"
);

let currentOffboarding = offboarding;
for (const task of offboarding.tasks) {
  currentOffboarding = await hr.completeHrTask({
    tenantId,
    actor,
    workflowId:offboarding.id,
    taskId:task.id,
    note:"测试完成",
    externalReference:task.external ? "IT停用回执 TEST-REVOKE-001" : ""
  });
}
assert.equal(currentOffboarding.status, "completed");
assert.equal(currentOffboarding.employee.status, "已离职");

const overview = await hr.getHrOverview({ tenantId, actor });
assert.equal(overview.employees.length, 1);
assert.equal(overview.employees[0].status, "已离职", "离职流程完成后员工列表状态必须同步为已离职");
assert.equal(overview.workflows.length, 2);
assert.equal(overview.workflows.filter((item) => item.status === "completed").length, 2);
assert.ok(overview.events.some((event) => event.type === "onboarding.created"));
assert.ok(overview.events.some((event) => event.type === "offboarding.created"));

const secondOnboarding = await hr.createOnboardingWorkflow({
  tenantId,
  actor,
  payload:{
    name:"测试员工乙",
    account_id:"employee.two@example.test",
    department:"内容运营部",
    position:"内容专员",
    start_date:new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    manager:"测试负责人乙"
  }
});
assert.equal(secondOnboarding.employee.account_id, "employee.two@example.test");

const resumeScreening = await hr.screenResume({
  tenantId,
  actor,
  payload:{
    job_title:"人事运营专员",
    candidate_label:"候选人-测试-001",
    job_description:"岗位职责：负责招聘、员工关系、绩效和Excel数据分析，要求3年以上相关经验。任职要求：沟通能力强，熟悉飞书和人力资源流程。",
    resume_text:"本人有5年人事运营经验，负责招聘、员工关系、绩效考核和Excel数据分析，熟悉飞书协同与人力资源流程，沟通能力良好。"
  }
});
assert.ok(resumeScreening.score >= 60);
assert.equal(resumeScreening.auto_reject, false);
assert.ok(resumeScreening.matched_terms.includes("招聘"));
assert.equal(typeof resumeScreening.resume_sha256, "string");
assert.equal(Object.hasOwn(resumeScreening, "owner"), false);
assert.doesNotMatch(JSON.stringify(resumeScreening), /李江龙/);
assert.doesNotMatch(JSON.stringify(resumeScreening), /本人有5年人事运营经验/);

const workLog = await hr.createHrWorkLog({
  tenantId,
  actor,
  payload:{
    account_id:"employee.one@example.test",
    source:"voice",
    content:"完成两位候选人初筛，并跟进一名员工入职材料。"
  }
});
assert.equal(workLog.source, "voice");
assert.equal(workLog.account_id, "employee.one@example.test");

for (const period of ["daily", "weekly", "monthly"]) {
  const report = await hr.generateHrReport({ tenantId, actor, period, accountId:"employee.one@example.test" });
  assert.equal(report.period, period);
  assert.equal(report.account_id, "employee.one@example.test");
  assert.ok(report.sections.length >= 3);
  assert.ok(Number.isFinite(report.metrics.onboarded));
  assert.match(report.automation_note, /外部账号|完成凭据/);
  assert.ok(report.sections.some((section) => section.key === "work_logs"));
  assert.equal(report.feishu_delivery.status, "not_configured");
}
const allReports = await hr.generateHrReport({ tenantId, actor, period:"daily" });
assert.equal(allReports.account_count, 2);
assert.deepEqual(new Set(allReports.reports.map((item) => item.account_id)), new Set(["employee.one@example.test", "employee.two@example.test"]));
const accountOverview = await hr.getHrOverview({ tenantId, actor });
for (const accountId of ["employee.one@example.test", "employee.two@example.test"]) {
  const reports = accountOverview.reports.filter((report) => report.account_id === accountId);
  for (const period of ["daily", "weekly", "monthly"]) {
    assert.ok(reports.some((report) => report.period === period), `${accountId}缺少${period}报告`);
  }
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const navSource = await readFile(new URL("../src/ui.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8");
const hrUiSource = await readFile(new URL("../src/modules/hr/index.js", import.meta.url), "utf8");
const hrCssSource = await readFile(new URL("../src/modules/hr/hr.css", import.meta.url), "utf8");
assert.match(navSource, /\["hr", "users", "人事管理"\]/);
assert.match(appSource, /renderHrPage/);
assert.match(appSource, /hr: renderHrPage/);
assert.match(hrUiSource, /pageHead\("", "人事管理"/);
assert.doesNotMatch(hrUiSource, /人事方向：叶苏、李凯朝/);
assert.match(apiSource, /\/api\/admin\/hr\/onboarding/);
assert.match(apiSource, /\/api\/admin\/hr\/offboarding/);
assert.match(apiSource, /\/api\/admin\/hr\/resume-screenings/);
assert.match(apiSource, /\/api\/admin\/hr\/resume-screenings\/file/);
assert.match(apiSource, /\/api\/admin\/hr\/resume-job-profile/);
assert.match(apiSource, /\/api\/admin\/hr\/work-logs/);
assert.match(apiSource, /reports\/generate/);
assert.match(hrUiSource, /简历筛选助手/);
assert.match(hrUiSource, /type="file"/);
assert.match(hrUiSource, /固定岗位名称/);
assert.match(hrUiSource, /hr-quick-resume-form/);
assert.doesNotMatch(hrUiSource, /李江龙/);
assert.match(hrUiSource, /报告生成助手 · 负责人：孟夕然/);
assert.match(hrUiSource, /语音输入/);
assert.match(hrUiSource, /飞书报告/);
assert.match(hrUiSource, /class="hr-resume-term-label"/);
assert.doesNotMatch(hrCssSource, /\.hr-resume-terms > div > span\s*\{/);
assert.match(hrCssSource, /\.hr-resume-terms \.badge\s*\{[^}]*width:auto/);
assert.match(hrCssSource, /\.hr-resume-terms \.badge\s*\{[^}]*overflow-wrap:anywhere/);
assert.equal(feishuReports.getFeishuReportStatus({}).configured, false);
let sentPayload = null;
const delivered = await feishuReports.deliverFeishuReport({
  employee_name:"测试员工",
  account_id:"test@example.test",
  period_label:"日报",
  range_start:new Date().toISOString(),
  range_end:new Date().toISOString(),
  sections:[{ title:"流程执行", items:["完成 1 项任务"] }]
}, {
  env:{ HUAMEI_FEISHU_REPORT_WEBHOOK:"https://example.test/feishu/report" },
  fetchImpl:async (_url, options) => {
    sentPayload = JSON.parse(options.body);
    return { ok:true, status:200, json:async () => ({ code:0, data:{ message_id:"om_test" } }) };
  }
});
assert.equal(delivered.status, "delivered");
assert.match(sentPayload.content.post.zh_cn.title, /测试员工 日报/);

console.log("hr-operations: passed");
