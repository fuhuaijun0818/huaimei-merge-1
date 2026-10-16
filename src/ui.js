import { icon } from "./icons.js";

export const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const safeImageSource = (value = "") => {
  const source = String(value || "").trim();
  if (!source || /[<>"'`\s]/.test(source)) return "";
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml)[,;]/i.test(source)) return source;
  if (/^(?:https?:\/\/|\/|\.\.?\/)/i.test(source)) return source;
  return /^[a-z0-9][a-z0-9_./?%=&+-]*$/i.test(source) ? source : "";
};

export const formatDate = (value, withTime = true) => {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
};

export const relativeTime = (value) => {
  if (!value) return "从未";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(Math.abs(diff) / 60000);
  const suffix = diff >= 0 ? "前" : "后";
  if (minutes < 60) return `${minutes}分钟${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时${suffix}`;
  return `${Math.round(hours / 24)}天${suffix}`;
};

export const badge = (text, variant = text) => `<span class="badge ${escapeHtml(variant)}">${escapeHtml(text)}</span>`;

// 未填写称呼的客户只显示中性占位，不用号码或推断姓名代替；真实姓名始终以服务端字段为准。
export const customerDisplayName = (customer) => String(customer?.name || "").trim() || "未填写称呼";

export const avatar = (customer, size = "") => {
  const hidden = customer.photoConsent === "已撤回";
  const photo = safeImageSource(customer.photo);
  if (!photo) return `<span class="avatar avatar-placeholder ${escapeHtml(size)}" role="img" aria-label="${escapeHtml(customerDisplayName(customer))}尚未上传照片">${escapeHtml(String(customer?.name || "").trim().slice(0, 1) || "客")}</span>`;
  return `<img class="avatar ${escapeHtml(size)} ${hidden ? "photo-mask" : ""}" src="${escapeHtml(photo)}" alt="${hidden ? "照片授权已撤回" : `${escapeHtml(customer.name)}的演示头像`}" />`;
};

export const physicianAvatar = (physician, size = "") => {
  const safeSize = String(size).split(/\s+/).filter((name) => /^[a-z][\w-]*$/i.test(name)).join(" ");
  if (Number.isInteger(physician?.avatarIndex)) return `<span class="physician-avatar physician-photo-sprite physician-photo-${physician.avatarIndex} ${escapeHtml(safeSize)}" role="img" aria-label="${escapeHtml(physician.name)}的虚构写实医师头像"></span>`;
  const photo = safeImageSource(physician?.avatar);
  if (!photo) return `<span class="physician-avatar physician-avatar-placeholder ${escapeHtml(safeSize)}" role="img" aria-label="${escapeHtml(physician?.name || "医师")}尚未上传照片">${escapeHtml(physician?.name?.slice(0, 1) || "医")}</span>`;
  return `<img class="physician-avatar ${escapeHtml(safeSize)}" src="${escapeHtml(photo)}" alt="${escapeHtml(physician.name)}的演示头像" />`;
};

export const customerCell = (customer) => `<div class="customer-cell">
  ${avatar(customer, "sm")}
  <div><button class="link customer-name" data-customer="${escapeHtml(customer.id)}">${escapeHtml(customerDisplayName(customer))}</button>
  <div class="customer-meta">${escapeHtml(customer.id)} · ${escapeHtml(customer.mobile)}${customer.stageEnteredAt ? ` · 建档 ${escapeHtml(relativeTime(customer.stageEnteredAt))}` : ""}</div></div>
</div>`;

export const card = (title, body, options = {}) => `<section class="card ${options.className || ""}">
  <div class="card-head"><div><div class="card-title">${title}</div>${options.subtitle ? `<div class="card-subtitle">${options.subtitle}</div>` : ""}</div>${options.action || ""}</div>
  <div class="card-body">${body}</div>
</section>`;

export const metric = (label, value, change, name = "spark", unit = "") => `<div class="card metric-card">
  <div class="metric-label"><span>${label}</span><span class="metric-icon">${icon(name, 16)}</span></div>
  <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div>
  <div class="metric-change ${String(change).startsWith("-") ? "down" : ""}">${change}</div>
</div>`;

export const pageHead = (eyebrow, title, desc, actions = "") => `<header class="page-head">
  <div><div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="page-desc">${desc}</p></div>
  <div class="head-actions">${actions}</div>
</header>`;

export const empty = (title, desc) => `<div class="empty"><div class="empty-icon">${icon("search", 24)}</div><strong>${title}</strong><div class="caption" style="margin-top:6px">${desc}</div></div>`;

export const button = (label, action, options = {}) => `<button class="btn ${options.variant || ""} ${options.size || ""}" data-action="${action}" ${options.id ? `data-id="${options.id}"` : ""} ${options.disabled ? "disabled" : ""}>${options.icon ? icon(options.icon, 15) : ""}${label}</button>`;

let modalReturnFocus = null;
let modalSequence = 0;

const pauseModalMedia = (root) => root?.querySelectorAll("video,audio").forEach((media) => media.pause?.());

export const openModal = ({ title, desc = "", body, footer = "", wide = false, role = "dialog", initialFocus = "", className = "", headerIcon = "" }) => {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  if (!root.contains(document.activeElement)) modalReturnFocus = document.activeElement;
  pauseModalMedia(root);
  const sequence = ++modalSequence;
  const titleId = `modal-title-${sequence}`;
  const descId = `modal-desc-${sequence}`;
  const dialogRole = role === "alertdialog" ? "alertdialog" : "dialog";
  const safeClassName = String(className).split(/\s+/).filter((name) => /^[a-z][\w-]*$/i.test(name)).join(" ");
  const modalClasses = ["modal", wide ? "wide" : "", safeClassName].filter(Boolean).join(" ");
  root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="${modalClasses}" role="${dialogRole}" aria-modal="true" aria-labelledby="${titleId}" ${desc ? `aria-describedby="${descId}"` : ""} tabindex="-1">
    <header class="modal-head">${headerIcon ? `<span class="modal-head-icon">${headerIcon}</span>` : ""}<div class="modal-head-copy"><div class="modal-title" id="${titleId}">${escapeHtml(title)}</div>${desc ? `<div class="modal-desc" id="${descId}">${escapeHtml(desc)}</div>` : ""}</div><button class="btn icon-only ghost" data-action="modal-close" aria-label="关闭">${icon("close", 18)}</button></header>
    <div class="modal-body">${body}</div>${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}
  </section></div>`;
  requestAnimationFrame(() => {
    const preferred = initialFocus ? root.querySelector(initialFocus) : root.querySelector("[data-modal-initial-focus]");
    (preferred || root.querySelector(".modal"))?.focus();
  });
};

export const closeModal = () => {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  pauseModalMedia(root);
  root.innerHTML = "";
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
};

document.addEventListener("keydown", (event) => {
  const root = document.querySelector("#modal-root");
  const modal = root?.querySelector(".modal");
  if (!modal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll('a[href],button:not([disabled]),audio[controls],video[controls],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (document.activeElement === modal || !modal.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

export const toast = (message, variant = "") => {
  const root = document.querySelector("#toast-root");
  const item = document.createElement("div");
  item.className = `toast ${variant}`;
  item.setAttribute("role", variant === "danger" ? "alert" : "status");
  item.innerHTML = `${icon(variant === "danger" ? "alert" : "check", 18)}<div>${escapeHtml(message)}</div>`;
  root.append(item);
  setTimeout(() => item.remove(), 3200);
};

export const formField = (label, name, value = "", options = {}) => `<label class="form-group ${options.full ? "full" : ""}">
  <span class="form-label">${label}</span>
  ${options.type === "textarea"
    ? `<textarea class="form-control" name="${name}" ${options.required ? "required" : ""}>${escapeHtml(value)}</textarea>`
    : options.type === "select"
      ? `<select class="form-control" name="${name}">${options.items.map((item) => {
        const optionValue = typeof item === "object" && item !== null ? String(item.value ?? "") : String(item);
        const optionLabel = typeof item === "object" && item !== null ? String(item.label ?? optionValue) : String(item);
        return `<option value="${escapeHtml(optionValue)}" ${optionValue === String(value) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`;
      }).join("")}</select>`
      : `<input class="form-control" type="${options.type || "text"}" name="${name}" value="${escapeHtml(value)}" ${options.required ? "required" : ""} />`}
</label>`;

// 一级导航按运营人员的工作目标分组；页面路由保持不变，避免旧链接失效。
// 每个分组中的条目就是后台的二级入口，避免把“项目、医生、知识、权限”等
// 不同性质的内容平铺在同一层，让运营人员先确定工作域，再进入功能页。
export const navGroups = [
  {
    key: "overview",
    label: "总览",
    items: [["workbench", "home", "今日工作台"]]
  },
  {
    key: "customer-operations",
    label: "客户运营",
    items: [
      ["customers", "users", "客户与会员"],
      ["conversations", "message", "会话与接待"],
      ["journeys", "route", "自动化运营"]
    ]
  },
  {
    key: "service-intelligence",
    label: "服务内容与智能体",
    items: [
      ["agents", "bot", "智能体中心"],
      ["catalog", "database", "项目与价格"],
      ["physicians", "medical", "医师团队"],
      ["knowledge", "shield", "知识与合规"]
    ]
  },
  {
    key: "governance",
    label: "经营治理",
    items: [
      ["analytics", "chart", "经营分析"],
      ["integrations", "settings", "系统配置"],
      ["administration", "settings", "组织与权限"]
    ]
  }
];

// 供面包屑、路由标题和兼容逻辑使用的平铺索引；侧边栏实际渲染使用 navGroups。
export const navItems = navGroups.flatMap((group) => group.items);
