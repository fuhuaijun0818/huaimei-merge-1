import assert from "node:assert/strict";
import JSZip from "jszip";

process.env.HUAMEI_FINANCE_STORE_FILE = ":memory:";
const finance = await import("../server/finance-operations.mjs");

const tenantId = "tenant-finance-test";
const actor = "finance-operator";
const petty = await finance.createPettyCashApplication({
  tenantId,
  actor,
  payload:{
    employee_name:"测试员工",
    employee_account:"employee.finance@example.test",
    company:"时代之美测试公司",
    project_name:"客户运营项目",
    amount:3200.5,
    purpose:"院区活动备用金"
  }
});
assert.equal(petty.application_status, "pending");
assert.equal(petty.writeoff_status, "not_issued");
assert.equal(petty.amount, 3200.5);

const issued = await finance.issuePettyCash({ tenantId, actor, id:petty.id, expectedVersion:petty.version });
assert.equal(issued.application_status, "approved");
assert.equal(issued.writeoff_status, "pending");
assert.ok(issued.issued_at);

await assert.rejects(
  finance.writeOffPettyCash({ tenantId, actor, id:petty.id, expectedVersion:issued.version, payload:{ written_off_amount:4000, writeoff_reference:"核销单-001" } }),
  (error) => error.code === "FINANCE_WRITEOFF_AMOUNT_EXCEEDED"
);
const writtenOff = await finance.writeOffPettyCash({
  tenantId,
  actor,
  id:petty.id,
  expectedVersion:issued.version,
  payload:{ written_off_amount:3000, writeoff_reference:"核销单-001" }
});
assert.equal(writtenOff.writeoff_status, "completed");
assert.equal(writtenOff.written_off_amount, 3000);

const expense = await finance.createFinanceRequest({
  tenantId,
  actor,
  payload:{
    type:"expense",
    company:"时代之美测试公司",
    expense_type:"差旅费",
    project_name:"招聘项目",
    applicant:"财务测试员工",
    employee_account:"employee.finance@example.test",
    amount:1280.35,
    cost_center:"人力行政",
    invoice_reference:"INV-001",
    description:"=HYPERLINK(\"https://invalid.example\",\"点击\")"
  }
});
const payment = await finance.createFinanceRequest({
  tenantId,
  actor,
  payload:{
    type:"payment",
    company:"时代之美测试公司",
    expense_type:"供应商付款",
    project_name:"知识库项目",
    applicant:"采购申请人",
    amount:5000,
    cost_center:"运营中心",
    invoice_reference:"PAY-001",
    description:"供应商阶段款"
  }
});
const procurement = await finance.createFinanceRequest({
  tenantId,
  actor,
  payload:{
    type:"procurement",
    company:"时代之美测试公司",
    expense_type:"设备采购",
    project_name:"院区设备项目",
    applicant:"设备申请人",
    amount:8000,
    cost_center:"院区运营",
    invoice_reference:"PO-001",
    description:"设备采购待审批"
  }
});
assert.equal(expense.approval_status, "pending");
const approvedExpense = await finance.approveFinanceRequest({ tenantId, actor, id:expense.id, expectedVersion:expense.version });
const approvedPayment = await finance.approveFinanceRequest({ tenantId, actor, id:payment.id, expectedVersion:payment.version });
assert.equal(approvedExpense.approval_status, "approved");
assert.equal(approvedPayment.approved_by, actor);
await assert.rejects(
  finance.approveFinanceRequest({ tenantId, actor, id:expense.id, expectedVersion:expense.version }),
  (error) => error.code === "FINANCE_VERSION_CONFLICT"
);

const exported = await finance.exportApprovedFinanceRequests({ tenantId, actor });
assert.match(exported.file_name, /^财务审批已完成_\d{14}\.xlsx$/);
assert.ok(exported.count >= 2);
const zip = await JSZip.loadAsync(exported.buffer);
assert.ok(zip.file("xl/workbook.xml"));
assert.ok(zip.file("xl/worksheets/sheet1.xml"));
assert.ok(zip.file("xl/styles.xml"));
const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
assert.match(sheet, /所属公司/);
assert.match(sheet, /费用类型/);
assert.match(sheet, /费用金额（元）/);
assert.match(sheet, /项目名称/);
assert.match(sheet, /1280\.35/);
assert.match(sheet, /5000/);
assert.doesNotMatch(sheet, new RegExp(procurement.id));
assert.ok(sheet.includes("&apos;=HYPERLINK"));

const overview = await finance.getFinanceOverview({ tenantId });
assert.equal(overview.pettyCash.length, 1);
assert.equal(overview.pettyCash[0].writeoff_status, "completed");
assert.equal(overview.requests.length, 3);
assert.equal(overview.requests.filter((item) => item.approval_status === "approved").length, 2);
assert.ok(overview.events.some((item) => item.type === "finance.export.completed"));

console.log("finance-operations: passed");
