import { icon } from "../../icons.js";
import { badge, card, closeModal, empty, escapeHtml, formField, formatDate, metric, openModal, pageHead, toast } from "../../ui.js";

const ui = {
  loaded:false,
  loading:false,
  error:"",
  tab:"overview",
  pettyFilter:"all",
  requestFilter:"all",
  data:null
};

const requestTypes = Object.freeze({
  expense:"费用报销",
  payment:"付款申请",
  procurement:"采购申请"
});
const tabs = [
  ["overview", "总览"],
  ["petty", "备用金"],
  ["requests", "财务审批"]
];
const amount = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits:2, maximumFractionDigits:2 }).format(Number(value) || 0);
const requestType = (value) => requestTypes[value] || value || "未分类";
const key = (prefix) => `${prefix}-${crypto.randomUUID()}`.slice(0, 128);
const fileBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => resolve(String(reader.result || "").split(",")[1] || ""));
  reader.addEventListener("error", () => reject(new Error("凭据图片读取失败")));
  reader.readAsDataURL(file);
});

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
    throw Object.assign(new Error("财务服务暂时不可用，请稍后重试"), { code:"FINANCE_NETWORK_UNAVAILABLE", cause:error });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body.data;
  throw Object.assign(new Error(body.error?.message || "财务操作失败"), {
    code:body.error?.code || "FINANCE_REQUEST_FAILED",
    status:response.status,
    details:body.error?.details || []
  });
}

const refreshFinanceContent = () => {
  if (!location.hash.startsWith("#/finance")) return;
  const container = document.querySelector("#page-content");
  if (container) container.innerHTML = renderFinancePage();
};

const hydrateFinance = async ({ force = false, announce = false } = {}) => {
  if (ui.loading || (ui.loaded && !force)) return ui.data;
  ui.loading = true;
  ui.error = "";
  refreshFinanceContent();
  try {
    ui.data = await request("/api/admin/finance");
    ui.loaded = true;
    if (announce) toast("财务数据已刷新", "success");
    return ui.data;
  } catch (error) {
    ui.loaded = false;
    ui.error = error.message;
    if (announce) toast(error.message, "danger");
    return null;
  } finally {
    ui.loading = false;
    refreshFinanceContent();
  }
};

const financeMetrics = () => {
  const pettyCash = ui.data?.pettyCash || [];
  const requests = ui.data?.requests || [];
  const pendingWriteoff = pettyCash.filter((item) => item.writeoff_status === "pending").length;
  const pendingApprovals = requests.filter((item) => item.approval_status === "pending").length;
  const approved = requests.filter((item) => item.approval_status === "approved");
  return {
    pettyCash,
    requests,
    pendingWriteoff,
    pendingApprovals,
    approvedCount:approved.length,
    approvedAmount:approved.reduce((total, item) => total + Number(item.amount || 0), 0)
  };
};

const dashboard = () => {
  const metrics = financeMetrics();
  const events = (ui.data?.events || []).slice(0, 12);
  return `<div class="grid cols-4 finance-metrics">${metric("待核销备用金", String(metrics.pendingWriteoff), "已发放，等待员工核销", "wallet")}${metric("待完成审批", String(metrics.pendingApprovals), "费用报销、付款、采购", "clock")}${metric("已完成审批", String(metrics.approvedCount), "可导出为Excel", "check")}${metric("已完成金额", `¥${amount(metrics.approvedAmount)}`, "审批通过单据合计", "chart")}</div>
    <div class="grid finance-dashboard-grid">
      <section class="card padded"><div class="card-head"><div><div class="card-title">财务待办</div><div class="card-subtitle">只统计当前财务数据服务中的真实记录</div></div></div>
        <div class="finance-todo-list">
          <button data-action="finance-go-petty"><span>${icon("wallet",18)}</span><div><strong>${metrics.pendingWriteoff} 笔备用金待核销</strong><small>按员工是否核销筛选查看</small></div>${icon("chevron",16)}</button>
          <button data-action="finance-go-requests"><span>${icon("check",18)}</span><div><strong>${metrics.pendingApprovals} 笔财务申请待审批</strong><small>处理费用报销、付款或采购申请</small></div>${icon("chevron",16)}</button>
        </div>
      </section>
      <section class="card padded"><div class="card-head"><div><div class="card-title">最近财务动作</div><div class="card-subtitle">写入、核销、审批和导出均记录操作人</div></div></div>
        ${events.length ? `<div class="finance-events">${events.map((item) => `<div><span>${formatDate(item.at)}</span><strong>${escapeHtml(item.detail)}</strong><small>${escapeHtml(item.actor)}</small></div>`).join("")}</div>` : empty("暂无财务动作", "创建备用金或财务申请后会显示记录")}
      </section>
    </div>`;
};

const pettyStatus = (item) => {
  if (item.application_status === "pending") return { label:"待发放", tone:"warning" };
  if (item.writeoff_status === "pending") return { label:"待核销", tone:"warning" };
  if (item.writeoff_status === "completed") return { label:"已核销", tone:"success" };
  return { label:"未发放", tone:"outline" };
};

const pettyPage = () => {
  const all = ui.data?.pettyCash || [];
  const rows = all.filter((item) => ui.pettyFilter === "all"
    || (ui.pettyFilter === "pending" && item.writeoff_status === "pending")
    || (ui.pettyFilter === "completed" && item.writeoff_status === "completed")
    || (ui.pettyFilter === "not_issued" && item.writeoff_status === "not_issued"));
  const action = item => item.application_status === "pending"
    ? `<button class="link" data-action="finance-issue-petty" data-id="${escapeHtml(item.id)}">确认发放</button>`
    : item.writeoff_status === "pending"
      ? `<button class="link" data-action="finance-writeoff-petty" data-id="${escapeHtml(item.id)}">登记核销</button>`
      : '<span class="caption">已处理</span>';
  return `<div class="finance-toolbar"><label><span>员工核销状态</span><select id="finance-petty-filter">
    ${[["all","全部"],["not_issued","尚未发放"],["pending","待核销"],["completed","已核销"]].map(([value, label]) => `<option value="${value}" ${ui.pettyFilter === value ? "selected" : ""}>${label}</option>`).join("")}
  </select></label><span>当前显示 ${rows.length} / ${all.length} 笔</span><button class="btn primary" data-action="finance-new-petty">${icon("plus",14)}新增备用金申请</button></div>
  <section class="card">${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>员工</th><th>公司与项目</th><th>申请金额</th><th>发放时间</th><th>核销状态</th><th>核销金额 / 凭据</th><th>操作</th></tr></thead><tbody>${rows.map((item) => {
    const status = pettyStatus(item);
    return `<tr><td><strong>${escapeHtml(item.employee_name)}</strong><div class="caption">${escapeHtml(item.employee_account)}</div></td><td>${escapeHtml(item.company)}<div class="caption">${escapeHtml(item.project_name || "未填写项目")} · ${escapeHtml(item.purpose)}</div></td><td><strong>¥${amount(item.amount)}</strong></td><td>${item.issued_at ? formatDate(item.issued_at) : "尚未发放"}</td><td>${badge(status.label, status.tone)}</td><td>${item.written_off_at ? `¥${amount(item.written_off_amount)}<div class="caption">${escapeHtml(item.writeoff_reference)}</div>` : "待登记"}</td><td>${action(item)}</td></tr>`;
  }).join("")}</tbody></table></div>` : empty("没有符合条件的备用金", "调整核销状态筛选，或新增备用金申请。")}</section>`;
};

const requestPage = () => {
  const all = ui.data?.requests || [];
  const rows = all.filter((item) => ui.requestFilter === "all" || item.type === ui.requestFilter);
  const approvedCount = all.filter((item) => item.approval_status === "approved").length;
  return `<div class="finance-toolbar"><label><span>审批类型</span><select id="finance-request-filter">
    ${[["all","全部"],["expense","费用报销"],["payment","付款申请"],["procurement","采购申请"]].map(([value, label]) => `<option value="${value}" ${ui.requestFilter === value ? "selected" : ""}>${label}</option>`).join("")}
  </select></label><span>当前显示 ${rows.length} / ${all.length} 笔</span><div class="finance-toolbar-actions"><button class="btn" data-action="finance-export-approved" ${approvedCount ? "" : "disabled"}>${icon("download",14)}导出已完成审批 Excel</button><button class="btn primary" data-action="finance-new-request">${icon("plus",14)}新增财务申请</button></div></div>
  <section class="card">${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>流程类型</th><th>所属公司 / 项目</th><th>费用类型</th><th>申请人</th><th>金额</th><th>凭据图片</th><th>审批状态</th><th>完成时间</th><th>操作</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${badge(requestType(item.type), "outline")}<div class="caption">${escapeHtml(item.id)}</div></td><td><strong>${escapeHtml(item.company)}</strong><div class="caption">${escapeHtml(item.project_name)}</div></td><td>${escapeHtml(item.expense_type)}<div class="caption">${escapeHtml(item.cost_center || "未填成本中心")}</div></td><td>${escapeHtml(item.applicant)}<div class="caption">${escapeHtml(item.employee_account || "")}</div></td><td><strong>¥${amount(item.amount)}</strong></td><td>${(item.evidence || []).length ? item.evidence.map((evidence) => `<button class="link" data-action="finance-preview-evidence" data-request-id="${escapeHtml(item.id)}" data-id="${escapeHtml(evidence.id)}">${escapeHtml(evidence.file_name)}</button>`).join("<br/>") : '<span class="caption">未上传</span>'}</td><td>${badge(item.approval_status === "approved" ? "审批完成" : "待审批", item.approval_status === "approved" ? "success" : "warning")}</td><td>${item.approved_at ? formatDate(item.approved_at) : "—"}</td><td>${item.approval_status === "pending" ? `<button class="link" data-action="finance-approve-request" data-id="${escapeHtml(item.id)}">完成审批</button>` : '<span class="caption">已完成</span>'}</td></tr>`).join("")}</tbody></table></div>` : empty("没有符合条件的财务申请", "调整审批类型筛选，或新增费用报销、付款、采购申请。")}</section>`;
};

export function renderFinancePage() {
  if (!ui.loaded && !ui.loading) window.setTimeout(() => { void hydrateFinance(); }, 0);
  const content = !ui.loaded
    ? ui.error
      ? `<div class="risk-banner">${icon("alert",16)}<div><strong>财务数据暂时无法读取</strong><br/>${escapeHtml(ui.error)}</div></div>`
      : `<section class="card">${empty(ui.loading ? "正在读取财务数据" : "正在准备财务模块", "将读取备用金、费用报销、付款和采购审批记录。")}</section>`
    : ({ overview:dashboard, petty:pettyPage, requests:requestPage }[ui.tab] || dashboard)();
  return `<div class="page finance-page">${pageHead("财务治理", "财务管理", "备用金核销、费用审批与Excel导出仅对财务岗位开放。", `<button class="btn" data-action="finance-refresh">${icon("refresh",15)}刷新</button>`)}
    <nav class="module-subnav finance-tabs" aria-label="财务管理二级导航">${tabs.map(([id, label]) => `<button class="${ui.tab === id ? "active" : ""}" data-action="finance-tab" data-id="${id}" ${ui.tab === id ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>
    <div class="finance-body">${content}</div>
  </div>`;
}

const showPettyCashModal = () => {
  openModal({
    title:"新增备用金申请",
    desc:"登记员工备用金；发放后进入待核销，财务可按核销状态筛选查看。",
    wide:true,
    body:`<form id="finance-petty-form" class="form-grid">
      ${formField("员工姓名","employee_name","",{required:true})}
      ${formField("员工登录账号","employee_account","",{required:true})}
      ${formField("所属公司","company","",{required:true})}
      ${formField("项目名称","project_name","")}
      <label class="form-group"><span class="form-label">备用金金额（元）</span><input class="form-control" name="amount" type="number" min="0.01" step="0.01" required /></label>
      ${formField("用途","purpose","",{type:"textarea",full:true,required:true})}
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="finance-submit-form" data-id="finance-petty-form">提交申请</button>`
  });
};

const showWriteOffModal = (id) => {
  const record = (ui.data?.pettyCash || []).find((item) => item.id === id);
  if (!record) return toast("未找到备用金记录", "warning");
  openModal({
    title:`登记核销 · ${record.employee_name}`,
    desc:`申请金额 ¥${amount(record.amount)}；核销金额不得大于申请金额。`,
    body:`<form id="finance-writeoff-form" data-id="${escapeHtml(record.id)}" data-version="${record.version}"><div class="form-grid">
      <label class="form-group"><span class="form-label">实际核销金额（元）</span><input class="form-control" name="written_off_amount" type="number" min="0.01" step="0.01" value="${escapeHtml(record.amount)}" required /></label>
      ${formField("核销凭据 / 说明","writeoff_reference","",{required:true})}
    </div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="finance-submit-form" data-id="finance-writeoff-form">确认核销</button>`
  });
};

const showRequestModal = () => {
  openModal({
    title:"新增财务申请",
    desc:"登记费用报销、付款或采购申请；审批完成后才会进入Excel导出范围。",
    wide:true,
    body:`<form id="finance-request-form" class="form-grid">
      ${formField("流程类型","type","expense",{type:"select",items:Object.entries(requestTypes).map(([value, label]) => ({ value, label }))})}
      ${formField("所属公司","company","",{required:true})}
      ${formField("费用类型","expense_type","",{required:true})}
      ${formField("项目名称","project_name","",{required:true})}
      ${formField("申请人","applicant","",{required:true})}
      ${formField("工号 / 登录账号","employee_account","")}
      <label class="form-group"><span class="form-label">费用金额（元）</span><input class="form-control" name="amount" type="number" min="0.01" step="0.01" required /></label>
      ${formField("成本中心","cost_center","")}
      ${formField("发票 / 凭据号","invoice_reference","")}
      <label class="form-group full"><span class="form-label">发票 / 报销凭据图片（最多3张，每张5MB，支持JPG、PNG、WebP）</span><input class="form-control" name="evidence_files" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple /><span class="caption">图片用于财务审批和后续查看；服务端校验图片签名后保存，Excel会记录图片数量和文件名。</span></label>
      ${formField("报销说明","description","",{type:"textarea",full:true})}
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="finance-submit-form" data-id="finance-request-form">提交申请</button>`
  });
};

const downloadExport = async (target) => {
  if (target.disabled) return;
  target.disabled = true;
  const previous = target.innerHTML;
  target.textContent = "正在生成 Excel…";
  try {
    const response = await fetch("/api/admin/finance/exports/approved.xlsx", { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || "Excel导出失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fileName = encodedName ? decodeURIComponent(encodedName) : "财务审批已完成.xlsx";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    await hydrateFinance({ force:true });
    toast("已完成审批记录已导出为Excel", "success");
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    target.disabled = false;
    target.innerHTML = previous;
  }
};

const previewEvidence = async (requestId, evidenceId) => {
  const preview = window.open("", "_blank");
  if (preview) preview.opener = null;
  try {
    const response = await fetch(`/api/admin/finance/requests/${encodeURIComponent(requestId)}/evidence/${encodeURIComponent(evidenceId)}`, {
      credentials:"same-origin",
      cache:"no-store"
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || "凭据图片读取失败");
    }
    const url = URL.createObjectURL(await response.blob());
    if (preview) preview.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    preview?.close();
    toast(error.message, "danger");
  }
};

const submitFinanceForm = async (form) => {
  const data = Object.fromEntries(new FormData(form));
  if (form.id === "finance-petty-form") {
    await request("/api/admin/finance/petty-cash", {
      method:"POST",
      headers:{ "Idempotency-Key":key("finance-petty") },
      body:JSON.stringify(data)
    });
    closeModal();
    await hydrateFinance({ force:true });
    ui.tab = "petty";
    refreshFinanceContent();
    toast("备用金申请已创建", "success");
    return;
  }
  if (form.id === "finance-writeoff-form") {
    await request(`/api/admin/finance/petty-cash/${encodeURIComponent(form.dataset.id)}/write-off`, {
      method:"POST",
      headers:{ "Idempotency-Key":key("finance-writeoff") },
      body:JSON.stringify({ ...data, expected_version:Number(form.dataset.version) })
    });
    closeModal();
    await hydrateFinance({ force:true });
    ui.tab = "petty";
    refreshFinanceContent();
    toast("备用金核销已登记", "success");
    return;
  }
  const selectedEvidence = [...(form.querySelector('[name="evidence_files"]')?.files || [])];
  if (selectedEvidence.length > 3) throw new Error("每笔财务申请最多上传3张凭据图片");
  if (selectedEvidence.some((file) => file.size > 5 * 1024 * 1024)) throw new Error("每张凭据图片不能超过5MB");
  const evidenceFiles = await Promise.all(selectedEvidence.map(async (file) => ({
    file_name:file.name,
    mime_type:file.type,
    data_base64:await fileBase64(file)
  })));
  await request("/api/admin/finance/requests", {
    method:"POST",
    headers:{ "Idempotency-Key":key("finance-request") },
    body:JSON.stringify({ ...data, evidence_files:evidenceFiles })
  });
  closeModal();
  await hydrateFinance({ force:true });
  ui.tab = "requests";
  refreshFinanceContent();
  toast("财务申请已创建，等待审批", "success");
};

const handleFinanceAction = async (action, id, target) => {
  if (action === "finance-tab") {
    ui.tab = id;
    refreshFinanceContent();
    return;
  }
  if (action === "finance-refresh") return hydrateFinance({ force:true, announce:true });
  if (action === "finance-go-petty" || action === "finance-go-requests") {
    ui.tab = action.endsWith("petty") ? "petty" : "requests";
    refreshFinanceContent();
    return;
  }
  if (action === "finance-new-petty") return showPettyCashModal();
  if (action === "finance-new-request") return showRequestModal();
  if (action === "finance-writeoff-petty") return showWriteOffModal(id);
  if (action === "finance-issue-petty") {
    const record = (ui.data?.pettyCash || []).find((item) => item.id === id);
    if (!record) return toast("未找到备用金记录", "warning");
    try {
      await request(`/api/admin/finance/petty-cash/${encodeURIComponent(id)}/issue`, {
        method:"POST",
        headers:{ "Idempotency-Key":key("finance-issue") },
        body:JSON.stringify({ expected_version:record.version })
      });
      await hydrateFinance({ force:true });
      ui.tab = "petty";
      refreshFinanceContent();
      toast("备用金已发放，状态变为待核销", "success");
    } catch (error) {
      toast(error.message, "danger");
    }
    return;
  }
  if (action === "finance-approve-request") {
    const record = (ui.data?.requests || []).find((item) => item.id === id);
    if (!record) return toast("未找到财务申请", "warning");
    try {
      await request(`/api/admin/finance/requests/${encodeURIComponent(id)}/approve`, {
        method:"POST",
        headers:{ "Idempotency-Key":key("finance-approve") },
        body:JSON.stringify({ expected_version:record.version })
      });
      await hydrateFinance({ force:true });
      ui.tab = "requests";
      refreshFinanceContent();
      toast("财务审批已完成，可导出Excel", "success");
    } catch (error) {
      toast(error.message, "danger");
    }
    return;
  }
  if (action === "finance-export-approved") return downloadExport(target);
  if (action === "finance-preview-evidence") return previewEvidence(target.dataset.requestId || "", id);
  if (action === "finance-submit-form") {
    const form = document.getElementById(id);
    if (!form) return toast("表单已失效，请重新打开", "warning");
    form.requestSubmit();
  }
};

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-action]");
  if (!target || !String(target.dataset.action || "").startsWith("finance-")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void handleFinanceAction(target.dataset.action, target.dataset.id || "", target);
}, true);

document.addEventListener("change", (event) => {
  if (event.target?.id === "finance-petty-filter") {
    ui.pettyFilter = event.target.value;
    refreshFinanceContent();
  }
  if (event.target?.id === "finance-request-filter") {
    ui.requestFilter = event.target.value;
    refreshFinanceContent();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["finance-petty-form", "finance-writeoff-form", "finance-request-form"].includes(form.id)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  try {
    await submitFinanceForm(form);
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    form.dataset.submitting = "false";
  }
});
