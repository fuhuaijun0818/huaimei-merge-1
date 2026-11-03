import { icon } from "../../icons.js";
import { badge, card, closeModal, empty, escapeHtml, formField, formatDate, metric, openModal, pageHead, toast } from "../../ui.js";

const ui = {
  loaded:false,
  loading:false,
  error:"",
  tab:"overview",
  data:null
};

const tabs = [
  ["overview", "总览"],
  ["employees", "员工"],
  ["onboarding", "入职流程"],
  ["offboarding", "离职流程"],
  ["reports", "日报 / 周报 / 月报"]
];
const periodLabels = { daily:"日报", weekly:"周报", monthly:"月报" };
const statusTone = (status) => /完成|在职|正常/.test(String(status || "")) ? "success"
  : /逾期|风险/.test(String(status || "")) ? "danger"
    : /待|准备|交接|进行/.test(String(status || "")) ? "warning" : "outline";
const key = (prefix) => `${prefix}-${crypto.randomUUID()}`.slice(0, 128);

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials:"same-origin",
      cache:"no-store",
      ...options,
      headers:{ Accept:"application/json", ...(options.body ? { "Content-Type":"application/json" } : {}), ...(options.headers || {}) }
    });
  } catch (error) {
    throw Object.assign(new Error("人事数据服务暂时不可用，请稍后重试"), { code:"HR_NETWORK_UNAVAILABLE", cause:error });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body.data;
  throw Object.assign(new Error(body.error?.message || "人事操作失败"), {
    code:body.error?.code || "HR_REQUEST_FAILED",
    status:response.status,
    details:body.error?.details || []
  });
}

const refreshHrContent = () => {
  if (!location.hash.startsWith("#/hr")) return;
  const container = document.querySelector("#page-content");
  if (container) container.innerHTML = renderHrPage();
};

const hydrateHr = async ({ force = false, announce = false } = {}) => {
  if (ui.loading || (ui.loaded && !force)) return ui.data;
  ui.loading = true;
  ui.error = "";
  refreshHrContent();
  try {
    ui.data = await request("/api/admin/hr");
    ui.loaded = true;
    if (announce) toast("人事数据已刷新", "success");
    return ui.data;
  } catch (error) {
    ui.loaded = false;
    ui.error = error.message;
    if (announce) toast(error.message, "danger");
    return null;
  } finally {
    ui.loading = false;
    refreshHrContent();
  }
};

const overviewMetrics = () => {
  const data = ui.data || {};
  const employees = data.employees || [];
  const workflows = data.workflows || [];
  const openTasks = workflows.filter((item) => item.status !== "completed")
    .flatMap((workflow) => workflow.tasks.filter((task) => task.status !== "completed"));
  return {
    active:employees.filter((item) => item.status === "在职").length,
    onboarding:workflows.filter((item) => item.type === "onboarding" && item.status !== "completed").length,
    offboarding:workflows.filter((item) => item.type === "offboarding" && item.status !== "completed").length,
    overdue:openTasks.filter((task) => task.status === "overdue").length
  };
};

const workflowCard = (workflow) => {
  const completed = workflow.tasks.filter((task) => task.status === "completed").length;
  return `<article class="hr-workflow-card">
    <header>
      <div><span>${workflow.type === "onboarding" ? "入职流程" : "离职流程"}</span><h3>${escapeHtml(workflow.employee.name)}</h3></div>
      ${badge(workflow.stage, statusTone(workflow.stage))}
    </header>
    <div class="hr-workflow-meta">
      <span>${escapeHtml(workflow.employee.department)} · ${escapeHtml(workflow.employee.position)}</span>
      <strong>${completed}/${workflow.tasks.length} 项完成</strong>
    </div>
    <div class="hr-progress"><span style="width:${workflow.tasks.length ? Math.round(completed / workflow.tasks.length * 100) : 0}%"></span></div>
    <div class="hr-task-list">
      ${workflow.tasks.map((task) => `<div class="hr-task ${task.status === "completed" ? "is-complete" : ""}">
        <span class="hr-task-icon">${icon(task.status === "completed" ? "check" : task.status === "overdue" ? "alert" : "clock", 14)}</span>
        <div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.owner)} · 截止 ${escapeHtml(task.due_date || "待定")}${task.external ? " · 外部系统动作" : ""}</small></div>
        ${task.status === "completed"
          ? badge("已完成", "success")
          : `<button class="btn small" data-action="hr-complete-task" data-id="${escapeHtml(workflow.id)}" data-task-id="${escapeHtml(task.id)}">${task.external ? "登记外部完成" : "标记完成"}</button>`}
      </div>`).join("")}
    </div>
    <footer>${workflow.type === "onboarding" ? `入职日期 ${escapeHtml(workflow.start_date)}` : `最后工作日 ${escapeHtml(workflow.last_working_date)}`} · 系统自动推进</footer>
  </article>`;
};

const dashboard = () => {
  const metrics = overviewMetrics();
  const workflows = ui.data?.workflows || [];
  const events = ui.data?.events || [];
  const urgentTasks = workflows.filter((item) => item.status !== "completed")
    .flatMap((workflow) => workflow.tasks.filter((task) => task.status === "overdue").map((task) => ({ workflow, task })))
    .slice(0, 8);
  return `<div class="grid cols-4 hr-metrics">${metric("在职员工", String(metrics.active), "来自已生效员工记录", "users")}${metric("在办入职", String(metrics.onboarding), "自动生成准备清单", "plus")}${metric("在办离职", String(metrics.offboarding), "交接与权限待办", "route")}${metric("逾期任务", String(metrics.overdue), metrics.overdue ? "需要立即处理" : "当前无逾期", "clock")}</div>
    <div class="grid hr-dashboard-grid">
      ${card("待处理风险", urgentTasks.length
        ? `<div class="stack">${urgentTasks.map(({ workflow, task }) => `<div class="hr-risk-row"><span>${icon("alert",15)}</span><div><strong>${escapeHtml(workflow.employee.name)} · ${escapeHtml(task.title)}</strong><div class="caption">${escapeHtml(task.owner)} · 截止 ${escapeHtml(task.due_date || "待定")}</div></div><button class="link" data-action="hr-tab" data-id="${workflow.type === "onboarding" ? "onboarding" : "offboarding"}">查看流程</button></div>`).join("")}</div>`
        : empty("当前没有逾期人事任务", "系统会按入职或最后工作日自动生成提醒和风险状态。"), { subtitle:"按任务截止日期自动识别" })}
      ${card("最近自动事件", events.length
        ? `<div class="hr-event-list">${events.slice(0, 10).map((event) => `<div><span>${formatDate(event.at)}</span><strong>${escapeHtml(event.detail || event.type)}</strong><small>${escapeHtml(event.actor || "system")}</small></div>`).join("")}</div>`
        : empty("暂无人事事件", "创建入职或离职流程后，自动任务和状态变化会记录在这里。"))}
    </div>`;
};

const employeesPage = () => {
  const employees = ui.data?.employees || [];
  if (!employees.length) return empty("还没有员工记录", "创建入职流程后，员工会从“待入职”开始进入生命周期管理。");
  return `<section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>员工</th><th>部门 / 岗位</th><th>负责人</th><th>入职日期</th><th>状态</th><th>联系方式</th></tr></thead><tbody>${employees.map((employee) => `<tr><td><strong>${escapeHtml(employee.name)}</strong><div class="caption">${escapeHtml(employee.id)}</div></td><td>${escapeHtml(employee.department)}<div class="caption">${escapeHtml(employee.position)}</div></td><td>${escapeHtml(employee.manager)}</td><td>${escapeHtml(employee.start_date)}</td><td>${badge(employee.status, statusTone(employee.status))}</td><td>${escapeHtml(employee.mobile || "未填写")}<div class="caption">${escapeHtml(employee.email || "未填写邮箱")}</div></td></tr>`).join("")}</tbody></table></div></section>`;
};

const workflowsPage = (type) => {
  const workflows = (ui.data?.workflows || []).filter((item) => item.type === type);
  if (!workflows.length) return empty(type === "onboarding" ? "暂无入职流程" : "暂无离职流程", type === "onboarding" ? "发起入职后，系统会自动生成资料、合同、账号、资产、培训和报到任务。" : "发起离职后，系统会自动生成交接、资产、账号、财务和面谈任务。");
  return `<div class="hr-workflow-grid">${workflows.map(workflowCard).join("")}</div>`;
};

const reportsPage = () => {
  const reports = ui.data?.reports || [];
  const generator = `<div class="hr-report-actions">${Object.entries(periodLabels).map(([period, label]) => `<button class="btn" data-action="hr-generate-report" data-id="${period}">生成${label}</button>`).join("")}</div>`;
  if (!reports.length) return `${generator}<section class="card">${empty("还没有人事报告", "生成后会按当前员工、流程和任务记录汇总，不填充虚构数据。")}</section>`;
  return `${generator}<div class="stack">${reports.slice(0, 30).map((report) => `<article class="card hr-report">
    <header><div><span>${escapeHtml(report.period_label)}</span><h3>${formatDate(report.range_start, false)} 至 ${formatDate(report.range_end, false)}</h3></div>${badge(`生成于 ${formatDate(report.generated_at)}`, "outline")}</header>
    <div class="hr-report-metrics">${Object.entries(report.metrics || {}).map(([name, value]) => `<div><strong>${Number(value) || 0}</strong><span>${escapeHtml(({ active_employees:"在职员工", onboarded:"完成入职", departed:"完成离职", open_onboarding:"在办入职", open_offboarding:"在办离职", completed_tasks:"本期完成任务", overdue_tasks:"逾期任务" })[name] || name)}</span></div>`).join("")}</div>
    <div class="hr-report-sections">${(report.sections || []).map((section) => `<section><h4>${escapeHtml(section.title)}</h4><ul>${(section.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`).join("")}</div>
    <p class="caption">${escapeHtml(report.automation_note)}</p>
  </article>`).join("")}</div>`;
};

export function renderHrPage() {
  if (!ui.loaded && !ui.loading) window.setTimeout(() => { void hydrateHr(); }, 0);
  const metrics = overviewMetrics();
  const content = !ui.loaded
    ? ui.error
      ? `<div class="risk-banner">${icon("alert",16)}<div><strong>人事数据暂时无法读取</strong><br/>${escapeHtml(ui.error)}</div></div>`
      : `<section class="card">${empty(ui.loading ? "正在读取人事数据" : "正在准备人事模块", "将读取员工、入职离职流程和历史报告。")}</section>`
    : ({
        overview:dashboard,
        employees:employeesPage,
        onboarding:() => workflowsPage("onboarding"),
        offboarding:() => workflowsPage("offboarding"),
        reports:reportsPage
      }[ui.tab] || dashboard)();
  const actions = `<button class="btn" data-action="hr-refresh">${icon("refresh",15)}刷新</button><button class="btn" data-action="hr-new-offboarding">${icon("route",15)}发起离职</button><button class="btn primary" data-action="hr-new-onboarding">${icon("plus",15)}发起入职</button>`;
  return `<div class="page hr-page">${pageHead("经营治理", "人事管理", `独立人事工作台 · ${metrics.active} 名在职员工 · ${metrics.onboarding} 个在办入职 · ${metrics.offboarding} 个在办离职`, actions)}
    <nav class="module-subnav hr-tabs" aria-label="人事管理二级导航">${tabs.map(([id, label]) => `<button class="${ui.tab === id ? "active" : ""}" data-action="hr-tab" data-id="${id}" ${ui.tab === id ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>
    <div class="hr-body">${content}</div>
  </div>`;
}

const showOnboardingModal = () => {
  openModal({
    title:"发起入职",
    desc:"提交后自动生成资料、合同、账号、资产、带教和首日确认任务；账号开通等外部动作必须登记凭据后才算完成。",
    wide:true,
    body:`<form id="hr-onboarding-form" class="form-grid">
      ${formField("姓名","name","",{required:true})}
      ${formField("部门","department","",{required:true})}
      ${formField("岗位","position","",{required:true})}
      ${formField("入职日期","start_date",new Date().toISOString().slice(0, 10),{type:"date",required:true})}
      ${formField("直属负责人","manager","")}
      ${formField("手机号（选填）","mobile","")}
      ${formField("工作邮箱（选填）","email","")}
      <div class="form-group full"><div class="guardrail">${icon("shield",14)}这里只创建人事流程与本地员工记录，不会自动开通邮箱、企业微信、门禁或业务系统账号。</div></div>
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="hr-submit-form" data-id="hr-onboarding-form">创建入职流程</button>`
  });
};

const showOffboardingModal = () => {
  const employees = (ui.data?.employees || []).filter((item) => item.status !== "已离职");
  if (!employees.length) return toast("暂无可办理离职的在职或待入职员工", "warning");
  openModal({
    title:"发起离职",
    desc:"提交后自动生成交接、资产回收、账号停用、财务结算和离职面谈任务；外部账号停用需登记核验凭据。",
    wide:true,
    body:`<form id="hr-offboarding-form" class="form-grid">
      ${formField("员工","employee_id","",{type:"select",required:true,items:employees.map((item) => ({ value:item.id, label:`${item.name} · ${item.department} · ${item.position}` }))})}
      ${formField("最后工作日","last_working_date",new Date().toISOString().slice(0, 10),{type:"date",required:true})}
      ${formField("交接对象","handover_to","")}
      ${formField("离职原因","reason","",{type:"textarea",full:true})}
      <div class="form-group full"><div class="guardrail">${icon("shield",14)}流程不会自动删除员工历史、客户记录或审计信息；账号与权限停用必须由 IT 实际执行并登记凭据。</div></div>
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn danger" data-action="hr-submit-form" data-id="hr-offboarding-form">创建离职流程</button>`
  });
};

const showCompleteTaskModal = (workflowId, taskId) => {
  const workflow = (ui.data?.workflows || []).find((item) => item.id === workflowId);
  const task = workflow?.tasks.find((item) => item.id === taskId);
  if (!workflow || !task) return toast("未找到该流程任务", "warning");
  openModal({
    title:`完成流程任务 · ${task.title}`,
    desc:`${workflow.employee.name} · ${workflow.type === "onboarding" ? "入职" : "离职"}流程 · 负责人 ${task.owner}`,
    body:`<form id="hr-complete-task-form" data-workflow-id="${escapeHtml(workflow.id)}" data-task-id="${escapeHtml(task.id)}"><div class="form-grid">
      ${formField("处理说明","note","",{type:"textarea",full:true})}
      ${task.external ? formField("外部完成凭据 / 核验说明","external_reference","",{required:true,full:true}) : ""}
      ${task.external ? `<div class="form-group full"><div class="guardrail">${icon("shield",14)}请确认外部系统动作已经实际完成。这里记录的是人工核验凭据，不会代替账号系统执行停用或开通。</div></div>` : ""}
    </div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="hr-submit-form" data-id="hr-complete-task-form">确认完成</button>`
  });
};

const handleHrAction = async (action, id, target) => {
  if (action === "hr-tab") {
    ui.tab = id;
    refreshHrContent();
    return;
  }
  if (action === "hr-refresh") {
    await hydrateHr({ force:true, announce:true });
    return;
  }
  if (action === "hr-new-onboarding") return showOnboardingModal();
  if (action === "hr-new-offboarding") return showOffboardingModal();
  if (action === "hr-complete-task") return showCompleteTaskModal(id, target.dataset.taskId || "");
  if (action === "hr-submit-form") {
    const form = document.getElementById(id);
    if (!form) return toast("表单已失效，请重新打开", "warning");
    form.requestSubmit();
    return;
  }
  if (action === "hr-generate-report") {
    if (target.disabled) return;
    target.disabled = true;
    const label = periodLabels[id] || "报告";
    target.textContent = `正在生成${label}…`;
    try {
      await request("/api/admin/hr/reports/generate", {
        method:"POST",
        headers:{ "Idempotency-Key":key(`hr-report-${id}`) },
        body:JSON.stringify({ period:id })
      });
      await hydrateHr({ force:true });
      toast(`${label}已生成`, "success");
    } catch (error) {
      toast(error.message, "danger");
    } finally {
      target.disabled = false;
      target.textContent = `生成${label}`;
    }
  }
};

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-action]");
  if (!target || !String(target.dataset.action || "").startsWith("hr-")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void handleHrAction(target.dataset.action, target.dataset.id || "", target);
}, true);

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["hr-onboarding-form", "hr-offboarding-form", "hr-complete-task-form"].includes(form.id)) return;
  form.dataset.hrSubmitSeen = "true";
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "hr-onboarding-form") {
      await request("/api/admin/hr/onboarding", {
        method:"POST",
        headers:{ "Idempotency-Key":key("hr-onboarding") },
        body:JSON.stringify(data)
      });
      closeModal();
      await hydrateHr({ force:true });
      ui.tab = "onboarding";
      refreshHrContent();
      toast("入职流程已创建，自动任务已生成", "success");
    } else if (form.id === "hr-offboarding-form") {
      await request("/api/admin/hr/offboarding", {
        method:"POST",
        headers:{ "Idempotency-Key":key("hr-offboarding") },
        body:JSON.stringify(data)
      });
      closeModal();
      await hydrateHr({ force:true });
      ui.tab = "offboarding";
      refreshHrContent();
      toast("离职流程已创建，交接任务已生成", "success");
    } else {
      await request(`/api/admin/hr/workflows/${encodeURIComponent(form.dataset.workflowId)}/tasks/${encodeURIComponent(form.dataset.taskId)}/complete`, {
        method:"POST",
        headers:{ "Idempotency-Key":key("hr-task") },
        body:JSON.stringify(data)
      });
      closeModal();
      await hydrateHr({ force:true });
      toast("任务完成状态与流程进度已更新", "success");
    }
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    form.dataset.submitting = "false";
    if (submit) submit.disabled = false;
  }
}, true);
