import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_STORE_FILE = resolve(process.cwd(), ".local-data", "hr", "operations.json");
const STORE_FILE = String(process.env.HUAMEI_HR_STORE_FILE || "").trim();
const memoryMode = STORE_FILE === ":memory:";
const storeFile = memoryMode ? "" : resolve(STORE_FILE || DEFAULT_STORE_FILE);
const DAY_MS = 24 * 60 * 60 * 1000;
let memoryState = null;
let operationQueue = Promise.resolve();

const text = (value, max = 120) => String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const dateOnly = (value) => {
  const token = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : "";
};
const nowIso = () => new Date().toISOString();
const dayIso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const dateOffset = (baseDate, offset = 0) => new Date(
  Date.parse(`${dateOnly(baseDate)}T00:00:00.000Z`) + offset * DAY_MS
).toISOString().slice(0, 10);
const uid = (prefix) => `${prefix}_${randomUUID()}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

const emptyTenant = () => ({
  employees: [],
  workflows: [],
  reports: [],
  events: [],
  revision: 0
});

const emptyState = () => ({
  schemaVersion: 1,
  tenants: {}
});

const readState = async () => {
  if (memoryMode) {
    memoryState ||= emptyState();
    return clone(memoryState);
  }
  try {
    const parsed = JSON.parse(await readFile(storeFile, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.tenants || typeof parsed.tenants !== "object") throw new Error("invalid");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw Object.assign(new Error("人事数据文件无法读取，请检查本地数据服务"), { code:"HR_STORE_INVALID", status:500 });
  }
};

const writeState = async (state) => {
  if (memoryMode) {
    memoryState = clone(state);
    return;
  }
  await mkdir(dirname(storeFile), { recursive:true });
  await writeFile(storeFile, `${JSON.stringify(state, null, 2)}\n`, { encoding:"utf8", mode:0o600 });
};

const withState = (operation) => {
  const run = operationQueue.then(async () => {
    const state = await readState();
    const result = await operation(state);
    await writeState(state);
    return result;
  });
  operationQueue = run.catch(() => {});
  return run;
};

const tenantState = (state, tenantId) => {
  const key = text(tenantId, 120) || "default";
  state.tenants[key] ||= emptyTenant();
  const tenant = state.tenants[key];
  for (const field of ["employees", "workflows", "reports", "events"]) {
    if (!Array.isArray(tenant[field])) tenant[field] = [];
  }
  const usedAccounts = new Set();
  for (const employee of tenant.employees) {
    let accountId = text(employee.account_id, 100);
    if (!accountId) {
      const base = text(employee.email, 120).toLowerCase()
        || `employee-${String(employee.id || "").replace(/^hremp_/, "").slice(0, 8)}`;
      accountId = base;
      let suffix = 2;
      while (usedAccounts.has(accountId.toLowerCase())) accountId = `${base}-${suffix++}`;
      employee.account_id = accountId;
    }
    usedAccounts.add(accountId.toLowerCase());
  }
  tenant.revision = Math.max(0, Number(tenant.revision) || 0);
  return tenant;
};

const appendEvent = (tenant, { type, workflow = null, employee = null, actor = "system", detail = "" }) => {
  tenant.events.unshift({
    id:uid("hrevt"),
    type:text(type, 80),
    workflow_id:workflow?.id || "",
    employee_id:employee?.id || workflow?.employee?.id || "",
    actor:text(actor, 120) || "system",
    detail:text(detail, 500),
    at:nowIso()
  });
  tenant.events = tenant.events.slice(0, 5000);
};

const task = ({ title, category, owner, dueDate, required = true, external = false }) => ({
  id:uid("hrtask"),
  title:text(title, 120),
  category:text(category, 40),
  owner:text(owner, 80),
  due_date:dateOnly(dueDate),
  required:required !== false,
  external:external === true,
  status:"pending",
  completed_at:null,
  completed_by:"",
  note:""
});

const onboardingTasks = (employee, startDate) => [
  task({ title:"核验身份、学历与岗位资料", category:"资料", owner:"HR", dueDate:dateOffset(startDate, -7) }),
  task({ title:"完成劳动合同与保密协议签署", category:"合同", owner:"HR", dueDate:dateOffset(startDate, -5) }),
  task({ title:"提交账号、邮箱与业务系统权限申请", category:"账号", owner:"IT", dueDate:dateOffset(startDate, -3), external:true }),
  task({ title:"准备工位、电脑与门禁", category:"资产", owner:"行政", dueDate:dateOffset(startDate, -2) }),
  task({ title:"制定入职培训与首周目标", category:"带教", owner:employee.manager || "直属负责人", dueDate:startDate }),
  task({ title:"首日报到确认与入职面谈", category:"报到", owner:"HR", dueDate:startDate })
];

const offboardingTasks = (employee, lastWorkingDate) => [
  task({ title:"确认离职申请与最后工作日", category:"流程", owner:"HR", dueDate:dateOffset(lastWorkingDate, -5) }),
  task({ title:"完成客户、资料与在办事项交接", category:"交接", owner:employee.manager || "直属负责人", dueDate:dateOffset(lastWorkingDate, -3) }),
  task({ title:"回收电脑、工牌、门禁与其他资产", category:"资产", owner:"行政", dueDate:lastWorkingDate }),
  task({ title:"停用账号、邮箱、群组与业务权限", category:"账号", owner:"IT", dueDate:lastWorkingDate, external:true }),
  task({ title:"完成薪酬、报销与结算核验", category:"财务", owner:"财务", dueDate:lastWorkingDate }),
  task({ title:"完成离职面谈与原因归档", category:"面谈", owner:"HR", dueDate:lastWorkingDate })
];

const allTasksComplete = (workflow) => workflow.tasks.length > 0 && workflow.tasks.every((item) => item.status === "completed");

const reconcileWorkflow = (workflow, today = dayIso()) => {
  for (const item of workflow.tasks) {
    if (item.status === "pending" && item.due_date && item.due_date < today) item.status = "overdue";
  }
  const complete = allTasksComplete(workflow);
  if (workflow.type === "onboarding") {
    const employee = workflow.employee;
    if (complete && workflow.start_date <= today) {
      workflow.status = "completed";
      workflow.stage = "已入职";
      employee.status = "在职";
      employee.activated_at ||= nowIso();
    } else if (complete) {
      workflow.status = "ready";
      workflow.stage = "待入职日自动生效";
      employee.status = "待入职";
    } else {
      workflow.status = "in_progress";
      workflow.stage = workflow.start_date <= today ? "首日准备中" : "入职准备";
      employee.status = "待入职";
    }
  } else if (workflow.type === "offboarding") {
    const employee = workflow.employee;
    if (complete && workflow.last_working_date <= today) {
      workflow.status = "completed";
      workflow.stage = "已离职";
      employee.status = "已离职";
      employee.departed_at ||= nowIso();
    } else if (complete) {
      workflow.status = "ready";
      workflow.stage = "待最后工作日自动生效";
      employee.status = "待离职";
    } else {
      workflow.status = "in_progress";
      workflow.stage = workflow.last_working_date <= today ? "离职日待确认" : "离职交接";
      employee.status = "待离职";
    }
  }
  workflow.updated_at = nowIso();
  return workflow;
};

const reconcileTenant = (tenant) => {
  const today = dayIso();
  for (const workflow of tenant.workflows) {
    const previousStage = workflow.stage;
    const previousStatus = workflow.status;
    reconcileWorkflow(workflow, today);
    if (workflow.stage !== previousStage || workflow.status !== previousStatus) {
      appendEvent(tenant, {
        type:"workflow.auto_transition",
        workflow,
        employee:workflow.employee,
        actor:"system",
        detail:`${previousStage || "流程"} → ${workflow.stage}`
      });
    }
  }
  return tenant;
};

export async function getHrOverview({ tenantId, actor = "system" } = {}) {
  return withState(async (state) => {
    const tenant = reconcileTenant(tenantState(state, tenantId));
    ensureAccountReports(tenant, actor);
    tenant.revision += 1;
    return clone(tenant);
  });
}

export async function createOnboardingWorkflow({ tenantId, actor, payload = {} } = {}) {
  return withState(async (state) => {
    const tenant = reconcileTenant(tenantState(state, tenantId));
    const name = text(payload.name, 80);
    const accountId = text(payload.account_id, 100);
    const department = text(payload.department, 80);
    const position = text(payload.position, 80);
    const startDate = dateOnly(payload.start_date);
    if (!name || !accountId || !department || !position || !startDate) {
      throw Object.assign(new Error("姓名、登录账号、部门、岗位和入职日期不能为空"), { code:"HR_ONBOARDING_INVALID", status:400 });
    }
    if (tenant.workflows.some((item) => item.type === "onboarding" && item.status !== "completed" && item.employee.name === name)) {
      throw Object.assign(new Error("该姓名已有进行中的入职流程"), { code:"HR_ONBOARDING_DUPLICATE", status:409 });
    }
    if (tenant.employees.some((item) => String(item.account_id || "").toLowerCase() === accountId.toLowerCase() && item.status !== "已离职")) {
      throw Object.assign(new Error("该登录账号已绑定未离职员工"), { code:"HR_ACCOUNT_DUPLICATE", status:409 });
    }
    const employee = {
      id:uid("hremp"),
      name,
      account_id:accountId,
      department,
      position,
      manager:text(payload.manager, 80) || "待分配",
      mobile:text(payload.mobile, 32),
      email:text(payload.email, 120),
      status:"待入职",
      start_date:startDate,
      created_at:nowIso(),
      activated_at:null,
      departed_at:null
    };
    const workflow = {
      id:uid("hronb"),
      type:"onboarding",
      employee,
      start_date:startDate,
      status:"in_progress",
      stage:"入职准备",
      tasks:onboardingTasks(employee, startDate),
      automation:{
        auto_generate_tasks:true,
        auto_activate_on_date:true,
        external_actions:["账号、邮箱与业务系统权限开通"]
      },
      created_at:nowIso(),
      updated_at:nowIso()
    };
    tenant.employees.unshift(employee);
    tenant.workflows.unshift(workflow);
    appendEvent(tenant, { type:"onboarding.created", workflow, employee, actor, detail:`已自动生成 ${workflow.tasks.length} 项入职任务` });
    reconcileWorkflow(workflow);
    tenant.revision += 1;
    return clone(workflow);
  });
}

export async function createOffboardingWorkflow({ tenantId, actor, payload = {} } = {}) {
  return withState(async (state) => {
    const tenant = reconcileTenant(tenantState(state, tenantId));
    const employeeId = text(payload.employee_id, 80);
    const employee = tenant.employees.find((item) => item.id === employeeId);
    const lastWorkingDate = dateOnly(payload.last_working_date);
    if (!employee) throw Object.assign(new Error("未找到要办理离职的员工"), { code:"HR_EMPLOYEE_NOT_FOUND", status:404 });
    if (!lastWorkingDate) throw Object.assign(new Error("最后工作日不能为空"), { code:"HR_OFFBOARDING_INVALID", status:400 });
    if (employee.status === "已离职") throw Object.assign(new Error("该员工已完成离职"), { code:"HR_OFFBOARDING_DUPLICATE", status:409 });
    if (tenant.workflows.some((item) => item.type === "offboarding" && item.employee.id === employee.id && item.status !== "completed")) {
      throw Object.assign(new Error("该员工已有进行中的离职流程"), { code:"HR_OFFBOARDING_DUPLICATE", status:409 });
    }
    employee.status = "待离职";
    const workflow = {
      id:uid("hroff"),
      type:"offboarding",
      employee,
      last_working_date:lastWorkingDate,
      reason:text(payload.reason, 200),
      handover_to:text(payload.handover_to, 80),
      status:"in_progress",
      stage:"离职交接",
      tasks:offboardingTasks(employee, lastWorkingDate),
      automation:{
        auto_generate_tasks:true,
        auto_complete_on_date:true,
        external_actions:["账号、邮箱、群组与业务权限停用"]
      },
      created_at:nowIso(),
      updated_at:nowIso()
    };
    tenant.workflows.unshift(workflow);
    appendEvent(tenant, { type:"offboarding.created", workflow, employee, actor, detail:`已自动生成 ${workflow.tasks.length} 项离职任务` });
    reconcileWorkflow(workflow);
    tenant.revision += 1;
    return clone(workflow);
  });
}

export async function completeHrTask({ tenantId, actor, workflowId, taskId, note = "", externalReference = "" } = {}) {
  return withState(async (state) => {
    const tenant = reconcileTenant(tenantState(state, tenantId));
    const workflow = tenant.workflows.find((item) => item.id === workflowId);
    const item = workflow?.tasks.find((candidate) => candidate.id === taskId);
    if (!workflow || !item) throw Object.assign(new Error("未找到该流程任务"), { code:"HR_TASK_NOT_FOUND", status:404 });
    if (item.status === "completed") return clone(workflow);
    if (item.external && !text(externalReference, 200)) {
      throw Object.assign(new Error("外部系统动作必须填写完成凭据或核验说明"), { code:"HR_EXTERNAL_EVIDENCE_REQUIRED", status:400 });
    }
    Object.assign(item, {
      status:"completed",
      completed_at:nowIso(),
      completed_by:text(actor, 120) || "system",
      note:text(note, 300),
      external_reference:text(externalReference, 200)
    });
    reconcileWorkflow(workflow);
    appendEvent(tenant, { type:"workflow.task_completed", workflow, employee:workflow.employee, actor, detail:`${item.title}：${item.note || item.external_reference || "已完成"}` });
    tenant.revision += 1;
    return clone(workflow);
  });
}

const reportRange = (period, now = new Date()) => {
  const end = now;
  const start = new Date(now);
  if (period === "daily") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "weekly") {
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (period === "monthly") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    throw Object.assign(new Error("报告周期仅支持日报、周报或月报"), { code:"HR_REPORT_PERIOD_INVALID", status:400 });
  }
  return { start,end };
};

const reportPeriods = Object.freeze(["daily", "weekly", "monthly"]);
const reportPeriodLabel = Object.freeze({ daily:"日报", weekly:"周报", monthly:"月报" });

const buildAccountReport = (tenant, employee, period, { actor = "system", now = new Date() } = {}) => {
  const normalizedPeriod = { daily:"daily", weekly:"weekly", monthly:"monthly" }[period];
  const { start, end } = reportRange(normalizedPeriod, now);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const employeeWorkflows = tenant.workflows.filter((item) => item.employee.id === employee.id);
  const events = tenant.events.filter((item) => {
    const at = Date.parse(item.at || "");
    return item.employee_id === employee.id && Number.isFinite(at) && at >= startMs && at <= endMs;
  });
  const activatedAt = Date.parse(employee.activated_at || "");
  const departedAt = Date.parse(employee.departed_at || "");
  const openWorkflows = employeeWorkflows.filter((item) => item.status !== "completed");
  const openTasks = openWorkflows.flatMap((workflow) => workflow.tasks
    .filter((item) => item.status !== "completed")
    .map((task) => ({ workflow, task })));
  const overdue = openTasks.filter(({ task }) => task.status === "overdue");
  const periodLabel = reportPeriodLabel[normalizedPeriod];
  const eventCount = (type) => events.filter((item) => item.type === type).length;
  const report = {
    id:"",
    account_id:employee.account_id,
    employee_id:employee.id,
    employee_name:employee.name,
    department:employee.department,
    period:normalizedPeriod,
    period_label:periodLabel,
    range_start:start.toISOString(),
    range_end:end.toISOString(),
    generated_at:nowIso(),
    generated_by:text(actor, 120) || "system",
    metrics:{
      active_employees:employee.status === "在职" ? 1 : 0,
      onboarded:Number.isFinite(activatedAt) && activatedAt >= startMs && activatedAt <= endMs ? 1 : 0,
      departed:Number.isFinite(departedAt) && departedAt >= startMs && departedAt <= endMs ? 1 : 0,
      open_onboarding:openWorkflows.filter((item) => item.type === "onboarding").length,
      open_offboarding:openWorkflows.filter((item) => item.type === "offboarding").length,
      completed_tasks:eventCount("workflow.task_completed"),
      overdue_tasks:overdue.length
    },
    sections:[
      {
        key:"movement",
        title:"账号人员状态",
        items:[
          `账号：${employee.account_id}`,
          `当前员工状态：${employee.status}`,
          `本期新增在职 ${Number.isFinite(activatedAt) && activatedAt >= startMs && activatedAt <= endMs ? 1 : 0} 人`,
          `本期完成离职 ${Number.isFinite(departedAt) && departedAt >= startMs && departedAt <= endMs ? 1 : 0} 人`
        ]
      },
      {
        key:"workflow",
        title:"流程执行",
        items:[
          `本期完成任务 ${eventCount("workflow.task_completed")} 项`,
          `当前待办 ${openTasks.length} 项`,
          `逾期任务 ${overdue.length} 项`
        ]
      },
      {
        key:"risk",
        title:"风险与待办",
        items:overdue.length
          ? overdue.slice(0, 8).map(({ workflow, task }) => `${workflow.employee.name} · ${task.title}（截止 ${task.due_date || "未设置"}）`)
          : ["当前没有逾期人事任务"]
      }
    ],
    automation_note:"本报告按员工账号独立生成；流程任务、状态和统计由系统自动汇总，外部账号开通、权限停用、财务结算等动作必须在完成凭据登记后才计入完成。"
  };
  const rangeKey = start.toISOString().slice(0, 10);
  const existing = tenant.reports.find((item) => item.account_id === employee.account_id
    && item.period === normalizedPeriod
    && String(item.range_start || "").slice(0, 10) === rangeKey);
  if (existing) {
    report.id = existing.id || `hrreport_${Buffer.from(`${employee.account_id}:${normalizedPeriod}:${rangeKey}`).toString("base64url").slice(0, 32)}`;
    Object.assign(existing, report);
    return clone(existing);
  }
  report.id = `hrreport_${Buffer.from(`${employee.account_id}:${normalizedPeriod}:${rangeKey}`).toString("base64url").slice(0, 32)}`;
  tenant.reports.unshift(report);
  tenant.reports = tenant.reports.slice(0, 3000);
  return clone(report);
};

function ensureAccountReports(tenant, actor = "system", now = new Date()) {
  const accounts = tenant.employees.filter((item) => item.account_id);
  for (const employee of accounts) {
    for (const period of reportPeriods) buildAccountReport(tenant, employee, period, { actor, now });
  }
  return accounts;
}

export async function generateHrReport({ tenantId, actor, period = "daily", accountId = "" } = {}) {
  return withState(async (state) => {
    const tenant = reconcileTenant(tenantState(state, tenantId));
    const normalizedPeriod = { daily:"daily", weekly:"weekly", monthly:"monthly" }[period];
    if (!normalizedPeriod) {
      throw Object.assign(new Error("报告周期仅支持日报、周报或月报"), { code:"HR_REPORT_PERIOD_INVALID", status:400 });
    }
    const requestedAccount = text(accountId, 100);
    const employees = requestedAccount
      ? tenant.employees.filter((item) => item.account_id.toLowerCase() === requestedAccount.toLowerCase())
      : tenant.employees.filter((item) => item.account_id);
    if (!employees.length) {
      throw Object.assign(new Error("未找到对应的人事账号"), { code:"HR_REPORT_ACCOUNT_NOT_FOUND", status:404 });
    }
    const reports = employees.map((employee) => buildAccountReport(tenant, employee, normalizedPeriod, { actor }));
    for (const report of reports) {
      appendEvent(tenant, {
        type:"report.generated",
        employee:employees.find((item) => item.id === report.employee_id),
        actor,
        detail:`已生成${report.period_label}（${report.account_id}）`
      });
    }
    tenant.revision += 1;
    return reports.length === 1 ? reports[0] : { reports, account_count:reports.length };
  });
}
