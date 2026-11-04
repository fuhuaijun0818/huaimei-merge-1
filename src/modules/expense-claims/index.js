import { icon } from "../../icons.js";
import { badge, closeModal, empty, escapeHtml, formField, formatDate, metric, openModal, pageHead, toast } from "../../ui.js";

const ui = { loaded:false, loading:false, error:"", claims:[], identity:null };
const amount = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits:2, maximumFractionDigits:2 }).format(Number(value) || 0);
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
    throw Object.assign(new Error("费用申请服务暂时不可用，请稍后重试"), { code:"EXPENSE_CLAIM_NETWORK_UNAVAILABLE", cause:error });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body.data;
  throw Object.assign(new Error(body.error?.message || "费用申请操作失败"), {
    code:body.error?.code || "EXPENSE_CLAIM_FAILED",
    status:response.status
  });
}

const refreshExpenseClaimsContent = () => {
  if (!location.hash.startsWith("#/expense-claims")) return;
  const container = document.querySelector("#page-content");
  if (container) container.innerHTML = renderExpenseClaimsPage();
};

const hydrateExpenseClaims = async ({ force = false, announce = false } = {}) => {
  if (ui.loading || (ui.loaded && !force)) return ui.claims;
  ui.loading = true;
  ui.error = "";
  refreshExpenseClaimsContent();
  try {
    const [claims, identity] = await Promise.all([
      request("/api/admin/expense-claims"),
      request("/api/admin/identity")
    ]);
    ui.claims = claims;
    ui.identity = identity;
    ui.loaded = true;
    if (announce) toast("费用申请已刷新", "success");
    return ui.claims;
  } catch (error) {
    ui.loaded = false;
    ui.error = error.message;
    if (announce) toast(error.message, "danger");
    return [];
  } finally {
    ui.loading = false;
    refreshExpenseClaimsContent();
  }
};

const status = (item) => {
  if (item.approval_status === "approved") return { label:"审批完成", tone:"success" };
  if (item.type === "expense" && (item.evidence || []).length === 0) return { label:"待补充凭据", tone:"danger" };
  return { label:"待财务审批", tone:"warning" };
};

const claimsTable = () => {
  if (!ui.claims.length) return `<section class="card">${empty("还没有费用申请", "提交费用报销后，财务会在“财务管理”中审批。")}</section>`;
  return `<section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>申请编号</th><th>所属公司 / 项目</th><th>费用类型</th><th>金额</th><th>凭据截图</th><th>提交时间</th><th>审批状态</th></tr></thead><tbody>${ui.claims.map((item) => {
    const current = status(item);
    return `<tr><td>${escapeHtml(item.id)}</td><td><strong>${escapeHtml(item.company)}</strong><div class="caption">${escapeHtml(item.project_name)}</div></td><td>${escapeHtml(item.expense_type)}<div class="caption">${escapeHtml(item.cost_center || "未填成本中心")}</div></td><td><strong>¥${amount(item.amount)}</strong></td><td>${(item.evidence || []).length ? item.evidence.map((evidence) => `<div class="caption">${escapeHtml(evidence.file_name)}</div>`).join("") : '<span class="caption danger-text">未上传</span>'}</td><td>${formatDate(item.created_at)}</td><td>${badge(current.label, current.tone)}</td></tr>`;
  }).join("")}</tbody></table></div></section>`;
};

export function renderExpenseClaimsPage() {
  if (!ui.loaded && !ui.loading) window.setTimeout(() => { void hydrateExpenseClaims(); }, 0);
  const approved = ui.claims.filter((item) => item.approval_status === "approved");
  const submittedAmount = ui.claims.reduce((total, item) => total + Number(item.amount || 0), 0);
  const content = !ui.loaded
    ? ui.error
      ? `<div class="risk-banner">${icon("alert",16)}<div><strong>费用申请暂时无法读取</strong><br/>${escapeHtml(ui.error)}</div></div>`
      : `<section class="card">${empty(ui.loading ? "正在读取费用申请" : "正在准备费用申请", "将读取当前账号提交的费用报销记录。")}</section>`
    : `<div class="grid cols-3 expense-claim-metrics">${metric("我的申请", String(ui.claims.length), "仅当前账号可见", "wallet")}${metric("审批完成", String(approved.length), "财务已完成审批", "check")}${metric("申请总额", `¥${amount(submittedAmount)}`, "当前账号全部申请", "chart")}</div>
      <div class="expense-claim-owner">${icon("shield",16)}<div><strong>申请人：${escapeHtml(ui.identity?.display_name || ui.identity?.displayName || ui.identity?.subject || "当前实名账号")}</strong><span>提交后自动进入财务后台审批；财务账号是唯一审批入口。</span></div></div>
      ${claimsTable()}`;
  return `<div class="page expense-claims-page">${pageHead("员工自助", "费用申请", "提交费用报销并上传凭据截图；审批由财务后台完成。", `<button class="btn" data-action="expense-claim-refresh">${icon("refresh",15)}刷新</button><button class="btn primary" data-action="expense-claim-new">${icon("plus",15)}新增费用报销</button>`)}
    <div class="expense-claim-body">${content}</div>
  </div>`;
}

const showClaimModal = () => {
  openModal({
    title:"新增费用报销",
    desc:"申请人自动使用当前实名账号；必须上传至少一张凭据截图，提交后进入财务审批。",
    wide:true,
    body:`<form id="expense-claim-form" class="form-grid">
      <div class="form-group"><span class="form-label">申请人</span><input class="form-control" value="${escapeHtml(ui.identity?.display_name || ui.identity?.displayName || ui.identity?.subject || "当前实名账号")}" disabled /></div>
      <div class="form-group"><span class="form-label">登录账号</span><input class="form-control" value="${escapeHtml(ui.identity?.account || ui.identity?.subject || "")}" disabled /></div>
      ${formField("所属公司","company","",{required:true})}
      ${formField("费用类型","expense_type","",{required:true})}
      ${formField("项目名称","project_name","",{required:true})}
      ${formField("成本中心","cost_center","")}
      <label class="form-group"><span class="form-label">费用金额（元）</span><input class="form-control" name="amount" type="number" min="0.01" step="0.01" required /></label>
      ${formField("发票 / 凭据号","invoice_reference","")}
      <label class="form-group full"><span class="form-label">凭据截图（必传，最多3张，每张5MB）</span><input class="form-control" name="evidence_files" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple required /><span class="caption">支持JPG、PNG、WebP；服务端会校验图片签名后私有保存。</span></label>
      ${formField("报销说明","description","",{type:"textarea",full:true})}
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="expense-claim-submit" data-id="expense-claim-form">提交财务审批</button>`
  });
};

const submitClaim = async (form) => {
  const data = Object.fromEntries(new FormData(form));
  const files = [...(form.querySelector('[name="evidence_files"]')?.files || [])];
  if (!files.length) throw new Error("费用报销必须上传至少一张凭据截图");
  if (files.length > 3) throw new Error("每笔费用申请最多上传3张凭据截图");
  if (files.some((file) => file.size > 5 * 1024 * 1024)) throw new Error("每张凭据截图不能超过5MB");
  const evidenceFiles = await Promise.all(files.map(async (file) => ({
    file_name:file.name,
    mime_type:file.type,
    data_base64:await fileBase64(file)
  })));
  await request("/api/admin/expense-claims", {
    method:"POST",
    headers:{ "Idempotency-Key":key("expense-claim") },
    body:JSON.stringify({
      company:data.company,
      expense_type:data.expense_type,
      project_name:data.project_name,
      amount:data.amount,
      cost_center:data.cost_center,
      invoice_reference:data.invoice_reference,
      description:data.description,
      evidence_files:evidenceFiles
    })
  });
  closeModal();
  await hydrateExpenseClaims({ force:true });
  toast("费用报销已提交，等待财务审批", "success");
};

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-action]");
  if (!target || !String(target.dataset.action || "").startsWith("expense-claim-")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (target.dataset.action === "expense-claim-refresh") void hydrateExpenseClaims({ force:true, announce:true });
  if (target.dataset.action === "expense-claim-new") showClaimModal();
  if (target.dataset.action === "expense-claim-submit") {
    const form = document.getElementById(target.dataset.id);
    if (form) form.requestSubmit();
  }
}, true);

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id !== "expense-claim-form") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  try {
    await submitClaim(form);
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    form.dataset.submitting = "false";
  }
});
