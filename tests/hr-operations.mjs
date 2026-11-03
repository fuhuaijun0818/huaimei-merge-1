import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.HUAMEI_HR_STORE_FILE = ":memory:";
const hr = await import("../server/hr-operations.mjs");

const today = new Date().toISOString().slice(0, 10);
const tenantId = "tenant-hr-test";
const actor = "hr-admin-test";

const onboarding = await hr.createOnboardingWorkflow({
  tenantId,
  actor,
  payload:{
    name:"测试员工甲",
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
    payload:{ name:"测试员工甲", department:"客户运营部", position:"运营专员", start_date:today }
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
assert.equal(overview.workflows.length, 2);
assert.equal(overview.workflows.filter((item) => item.status === "completed").length, 2);
assert.ok(overview.events.some((event) => event.type === "onboarding.created"));
assert.ok(overview.events.some((event) => event.type === "offboarding.created"));

for (const period of ["daily", "weekly", "monthly"]) {
  const report = await hr.generateHrReport({ tenantId, actor, period });
  assert.equal(report.period, period);
  assert.ok(report.sections.length >= 3);
  assert.ok(Number.isFinite(report.metrics.onboarded));
  assert.match(report.automation_note, /外部动作/);
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const navSource = await readFile(new URL("../src/ui.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8");
assert.match(navSource, /\["hr", "users", "人事管理"\]/);
assert.match(appSource, /renderHrPage/);
assert.match(appSource, /hr: renderHrPage/);
assert.match(apiSource, /\/api\/admin\/hr\/onboarding/);
assert.match(apiSource, /\/api\/admin\/hr\/offboarding/);
assert.match(apiSource, /reports\/generate/);

console.log("hr-operations: passed");
