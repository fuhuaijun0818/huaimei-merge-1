import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

process.env.HUAMEI_FINANCE_STORE_FILE = ":memory:";
const evidenceRoot = mkdtempSync(join(tmpdir(), "huamei-finance-evidence-"));
process.env.HUAMEI_FINANCE_EVIDENCE_ROOT = evidenceRoot;
const finance = await import("../server/finance-operations.mjs");

const tenantId = "tenant-finance-test";
const actor = "finance-operator";
const receiptPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
await assert.rejects(
  finance.createFinanceRequest({
    tenantId,
    actor,
    payload:{
      type:"expense",
      company:"时代之美测试公司",
      expense_type:"差旅费",
      project_name:"非法凭据项目",
      applicant:"测试员工",
      amount:1,
      evidence_files:[{ file_name:"伪造.png", mime_type:"image/png", data_base64:Buffer.from("not-an-image").toString("base64") }]
    }
  }),
  (error) => error.code === "FINANCE_EVIDENCE_TYPE_INVALID"
);
await assert.rejects(
  finance.createFinanceRequest({
    tenantId,
    actor,
    payload:{
      type:"expense",
      company:"时代之美测试公司",
      expense_type:"差旅费",
      project_name:"无凭据报销项目",
      applicant:"测试员工",
      amount:100
    }
  }),
  (error) => error.code === "FINANCE_EVIDENCE_REQUIRED"
);
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
    description:"=HYPERLINK(\"https://invalid.example\",\"点击\")",
    evidence_files:[{
      file_name:"报销发票.png",
      mime_type:"image/png",
      data_base64:receiptPng.toString("base64")
    }]
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
assert.equal(expense.evidence.length, 1);
assert.equal(expense.evidence[0].file_name, "报销发票.png");
assert.equal(Object.hasOwn(expense.evidence[0], "storage_name"), false);
const evidence = await finance.getFinanceEvidence({
  tenantId,
  actor,
  requestId:expense.id,
  evidenceId:expense.evidence[0].id
});
assert.equal(evidence.mime_type, "image/png");
assert.deepEqual(evidence.buffer, receiptPng);
const paymentWithEvidence = await finance.attachFinanceRequestEvidence({
  tenantId,
  actor,
  id:payment.id,
  expectedVersion:payment.version,
  payload:{
    evidence_files:[{
      file_name:"付款凭据.png",
      mime_type:"image/png",
      data_base64:receiptPng.toString("base64")
    }]
  }
});
assert.equal(paymentWithEvidence.evidence.length, 1);
assert.equal(paymentWithEvidence.evidence[0].file_name, "付款凭据.png");
const approvedExpense = await finance.approveFinanceRequest({ tenantId, actor, id:expense.id, expectedVersion:expense.version });
const approvedPayment = await finance.approveFinanceRequest({ tenantId, actor, id:payment.id, expectedVersion:paymentWithEvidence.version });
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
assert.match(sheet, /凭据图片数量/);
assert.match(sheet, /凭据图片文件/);
assert.match(sheet, /报销发票\.png/);
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
const employeePrincipal = { subject:"staff_expense_employee_001", account:"employee.expense.001", displayName:"费用申请员工" };
const employeeClaim = await finance.submitEmployeeExpenseClaim({
  tenantId,
  principal:employeePrincipal,
  payload:{
    type:"payment",
    company:"时代之美测试公司",
    expense_type:"员工报销",
    project_name:"员工自助项目",
    amount:268.5,
    description:"员工账号提交的费用报销",
    evidence_files:[{
      file_name:"员工凭据.png",
      mime_type:"image/png",
      data_base64:receiptPng.toString("base64")
    }]
  }
});
assert.equal(employeeClaim.type, "expense");
assert.equal(employeeClaim.applicant, "费用申请员工");
assert.equal(employeeClaim.employee_account, "employee.expense.001");
assert.equal(employeeClaim.applicant_subject, employeePrincipal.subject);
assert.equal(employeeClaim.source, "employee_self_service");
const mine = await finance.listMyExpenseClaims({ tenantId, subject:employeePrincipal.subject });
assert.equal(mine.length, 1);
assert.equal(mine[0].id, employeeClaim.id);
const otherMine = await finance.listMyExpenseClaims({ tenantId, subject:"staff_other_account" });
assert.equal(otherMine.length, 0);
const approvedEmployeeClaim = await finance.approveFinanceRequest({
  tenantId,
  actor,
  id:employeeClaim.id,
  expectedVersion:employeeClaim.version
});
assert.equal(approvedEmployeeClaim.approval_status, "approved");
const financeUiSource = readFileSync(new URL("../src/modules/finance/index.js", import.meta.url), "utf8");
const financeServiceSource = readFileSync(new URL("../server/finance-operations.mjs", import.meta.url), "utf8");
const expenseClaimUiSource = readFileSync(new URL("../src/modules/expense-claims/index.js", import.meta.url), "utf8");
assert.match(financeUiSource, /finance-view-petty/);
assert.match(financeUiSource, /finance-view-request/);
assert.match(financeUiSource, /finance-evidence-gallery/);
assert.match(financeUiSource, /费用报销必须上传至少一张凭据截图/);
assert.match(financeUiSource, /evidence\.required = event\.target\.value === "expense"/);
assert.match(financeUiSource, /finance-add-evidence/);
assert.match(financeServiceSource, /FINANCE_EVIDENCE_REQUIRED/);
assert.match(expenseClaimUiSource, /\/api\/admin\/expense-claims/);
assert.match(expenseClaimUiSource, /费用报销必须上传至少一张凭据截图/);

console.log("finance-operations: passed");
rmSync(evidenceRoot, { recursive:true, force:true });
