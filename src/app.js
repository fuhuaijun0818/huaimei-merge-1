import { customerPresentation } from "./customer-presentation.js";
import { createConversationReadState } from "./conversation-unread.js";
const conversationReads = createConversationReadState();
import { logoutAdminSession } from "./admin-session.js";
import { ROLE_CATALOG, roleCatalogEntry } from "./role-catalog.js";
import { getManagementIdentity, getManagementAccounts, saveManagedAccount, getMemberIntegrationStatus, getKnowledgePublications, writeKnowledgePublication } from "./operations-client.js";
import { summarizePublicationRollback } from "./modules/knowledge/publication-rollback-diff.js";
import { indexStatusLabel, summarizeDocumentPublicationStatus, PUBLICATION_STATUS_LEGEND } from "./modules/knowledge/publication-status.js";
import { MESSAGE_TEMPLATE_CATEGORIES, MESSAGE_TEMPLATE_VARIABLES, renderTemplatePreview, normalizeTemplateCategory, extractTemplateVariables, templateVersionLabel } from "./modules/knowledge/message-template.js";
import { setIdentityCapabilities } from "./modules/administration/identity-capabilities.js";
import { sanitizeDisplayData, store } from "./store.js";
import {
  claimManagementAppointmentIntake,
  claimManagementHandover,
  completeManagementHandoverWithWork,
  getManagementKnowledgeGovernance,
  getManagementDomainOverlay,
  listManagementAcquisitionChannels,
  listManagementAppointmentIntakes,
  listManagementBadCases,
  listManagementHandovers,
  listManagementKnowledgeIntakeDocuments,
  revealManagementHandoverContact,
  revealManagementAppointmentContact,
  reviewManagementBadCase,
  resolveManagementAppointmentIntake,
  saveManagementDomainOverlay,
  uploadManagementKnowledgeIntakeAsset, getManagementKnowledgeIntakeDocument, mutateManagementKnowledgeIntakeDocument
} from "./operations-client.js";
import { stageSteps, riskWords } from "./data.js";
import { memberCheckPresentation } from "./member-check-display.js";
import { icon } from "./icons.js";
import {
  avatar, badge, button, card, closeModal, customerCell, empty, escapeHtml, formatDate, formField,
  metric, navGroups, navItems, openModal, pageHead, physicianAvatar, relativeTime, toast
} from "./ui.js";
import { entityNavRoute, entityTitle, moduleNavConfig, moduleSubnav, renderEntityPage, renderSubpage } from "./subpages.js";
import { handoverOnlyMode, knowledgeGovernanceEnabled, knowledgeIntakeEnabled, realManagementActions } from "./management-runtime.js";

// 知识资料的筛选仅在当前浏览器标签页内保留：刷新和前进/后退可以恢复，
// 不写入跨会话的 localStorage，也不会把检索关键词暴露到地址栏或浏览历史。
const KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY = "huamei:knowledge-intake-filter-state:v1";
const knowledgeIntakeFilterDefaults = Object.freeze({ query:"", status:"", contentType:"", publicScope:"" });
const knowledgeIntakeFilterOptions = Object.freeze({
  status:new Set(["", "parsing_pending", "draft", "release_candidate"]),
  contentType:new Set(["", "项目介绍", "医生介绍", "服务流程", "活动权益", "公开海报", "排班说明", "其他"]),
  publicScope:new Set(["", "internal", "customer_summary", "public_full"])
});
const loadKnowledgeIntakeFilterState = () => {
  try {
    const raw = globalThis.sessionStorage?.getItem(KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY);
    if (!raw) return { ...knowledgeIntakeFilterDefaults };
    const stored = JSON.parse(raw);
    return {
      query:typeof stored?.query === "string" ? stored.query.slice(0, 120) : "",
      status:knowledgeIntakeFilterOptions.status.has(stored?.status) ? stored.status : "",
      contentType:knowledgeIntakeFilterOptions.contentType.has(stored?.contentType) ? stored.contentType : "",
      publicScope:knowledgeIntakeFilterOptions.publicScope.has(stored?.publicScope) ? stored.publicScope : ""
    };
  } catch {
    return { ...knowledgeIntakeFilterDefaults };
  }
};
const initialKnowledgeIntakeFilters = loadKnowledgeIntakeFilterState();

const ui = {
  taskTab: "全部",
  customerView: "table",
  customerQuery: "",
  customerStage: "全部",
  customerOwner: "全部负责人",
  timelineFilter: "全部",
  conversationId: "V-01",
  conversationFilter: "全部",
  conversationQuery: "",
  receptionTab: "phrases",
  replyDrafts: {},
  journeyView: "list",
  journeyId: "J-01",
  journeyCanvasDrafts: {},
  journeyCanvasSelection: {},
  journeyCanvasZoom: {},
  knowledgeTab: "知识库",
  knowledgeQuery: "",
  knowledgeRisk: "全部风险",
  knowledgePart: "全部部位",
  knowledgePage: 1,
  knowledgePageSize: 10,
  listPagination: {},
  knowledgeGovernance: null,
  knowledgeGovernanceLoading: false,
  knowledgeGovernanceError: "",
  knowledgeGovernanceRequestToken: 0,
  knowledgeIntakeDocuments: [],
  knowledgeIntakeLoading: false,
  knowledgeIntakeError: "",
  knowledgeIntakeQuery: initialKnowledgeIntakeFilters.query,
  knowledgeIntakeStatus: initialKnowledgeIntakeFilters.status,
  knowledgeIntakeContentType: initialKnowledgeIntakeFilters.contentType,
  knowledgeIntakePublicScope: initialKnowledgeIntakeFilters.publicScope,
  knowledgeIntakeRequestToken: 0,
  knowledgeVersionConflict: null,
  physicianQuery: "",
  physicianStatus: "全部状态",
  physicianSpecialty: "全部领域",
  avatarRuntime: null,
  avatarJobs: [],
  avatarJobsPhysicianId: "",
  avatarLoading: false,
  avatarLoadingPhysicianId: "",
  avatarPollingPhysicianId: "",
  avatarPollingRequestToken: 0,
  avatarSubmittingPhysicianId: "",
  avatarSubmitToken: 0,
  avatarMutationCounts: {},
  avatarScopeEpoch: 0,
  avatarLoadError: "",
  avatarHydratedAt: 0,
  avatarPollTimer: null,
  avatarRequestToken: 0,
  avatarDrafts: {},
  settingsTab: "连接器",
  analyticsRange: "近30天",
  operationsLoading: false,
  operationsError: "",
  conversationSyncError: "",
  acquisitionChannelStatuses: [],
  acquisitionChannelsLoading: false,
  acquisitionChannelsError: "",
  appointmentIntakes: [],
  scheduleSlots: [],
  appointmentsLoading: false,
  appointmentsError: "",
  badCases: [],
  badCasesLoading: false,
  badCasesError: "",
  badCasesHydrated: false,
  managementDataReady: false,
  managementDataLoading: true,
  managementDataError: "",
  managementPersistenceState: "initializing",
  managementPersistenceError: ""
};

const persistKnowledgeIntakeFilterState = () => {
  const filters = {
    query:ui.knowledgeIntakeQuery.slice(0, 120),
    status:ui.knowledgeIntakeStatus,
    contentType:ui.knowledgeIntakeContentType,
    publicScope:ui.knowledgeIntakePublicScope
  };
  try {
    if (Object.values(filters).every((value) => !value)) {
      globalThis.sessionStorage?.removeItem(KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY);
      return;
    }
    globalThis.sessionStorage?.setItem(KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // 隐私模式或浏览器禁用会话存储时，筛选仍在当前页面内正常生效。
  }
};

const clearKnowledgeIntakeFilterState = () => {
  ui.knowledgeIntakeQuery = "";
  ui.knowledgeIntakeStatus = "";
  ui.knowledgeIntakeContentType = "";
  ui.knowledgeIntakePublicScope = "";
  persistKnowledgeIntakeFilterState();
};

// 一期后台当前只使用本系统已建档的数据。不要将旧演示大盘数字混入客户、
// 任务和会话的实时视图，避免不同模块的统计口径相互矛盾。
const managementOverviewMetrics = () => {
  const customers = store.state.customers || [];
  const tasks = store.state.tasks || [];
  const conversations = store.state.conversations || [];
  const countStage = (stage) => customers.filter((item) => item.macroStage === stage).length;
  const openTasks = tasks.filter((item) => !["已完成", "已取消"].includes(item.status));
  const overdueTasks = openTasks.filter((item) => item.status === "已超时" || (item.dueAt && Date.parse(item.dueAt) < Date.now()));
  return { customers, tasks, conversations, openTasks, overdueTasks, countStage };
};

// 一期仅对运营人员呈现两种业务角色。旧浏览器缓存可能仍使用“管理者”、
// “系统管理员”或“售前顾问”等名称，视图层需统一归一化；真正的权限判断
// 仍由服务端企业身份和 capability 完成，不能依赖这个本地视图状态。
const PHASE_ONE_ROLE_LABELS = Object.freeze(ROLE_CATALOG.map(r=>r.name));
const normalizePhaseOneRole = value => roleCatalogEntry(value)?.name || "未授权";
const currentPhaseOneRole = () => normalizePhaseOneRole(ui.managementIdentity?.role);
const isPresalesWorkspace = () => currentPhaseOneRole() === "售前顾问";
const presalesRouteAllowlist = new Set(["workbench", "customers", "conversations", "conversation"]);
const canOpenRouteInCurrentRole = route => {
 const key=roleCatalogEntry(currentPhaseOneRole())?.key;
 if(key==='superadministrator')return true;
 return key==="presales"?presalesRouteAllowlist.has(route):key==="administrator"?["workbench","administration","integrations"].includes(route):["content","publisher","quality"].includes(key)?["workbench","knowledge"].includes(route):false;
};
const presalesSubrouteAllowlist = Object.freeze({
  workbench: new Set([undefined, "overview", "takeovers"]),
  customers: new Set([undefined, "overview"]),
  conversations: new Set([undefined, "overview", "takeovers", "templates"])
});
const presalesAllowedActions = new Set([
  "list-page", "modal-close", "modal-backdrop", "notifications", "refresh", "refresh-handovers",
  "refresh-appointments", "claim-handover", "complete-handover", "robot-takeover", "reveal-contact",
  "claim-appointment", "resolve-appointment", "reveal-appointment-contact", "select-conversation", "conversation-filter",
  "open-phrase-library", "use-common-phrase", "customer-view", "timeline-filter", "reception-tab", "copy-reply-draft"
]);
const presalesAllowedForms = new Set(["handover-complete-form", "appointment-resolve-form"]);

const routeInfo = () => {
  const raw = location.hash.replace(/^#\/?/, "") || "workbench";
  const decodeSegment = (value = "") => {
    try { return decodeURIComponent(value); }
    catch { return value; }
  };
  const [route, id, resourceId] = raw.split("/").map(decodeSegment);
  if (handoverOnlyMode && route !== "workbench" && !((knowledgeGovernanceEnabled || knowledgeIntakeEnabled) && route === "knowledge")) return { route:"workbench", id:undefined, resourceId:undefined };
  if (!handoverOnlyMode && !canOpenRouteInCurrentRole(route)) return { route:"conversations", id:undefined, resourceId:undefined };
  if (!handoverOnlyMode && isPresalesWorkspace() && presalesSubrouteAllowlist[route] && !presalesSubrouteAllowlist[route].has(id)) return { route:"conversations", id:undefined, resourceId:undefined };
  return { route, id, resourceId };
};

const routeTitle = (route, id, resourceId) => {
  if (route === "customer") return store.customer(id)?.name || "客户360";
  if (route === "physicians" && id === "avatar") return resourceId ? `${store.physician(resourceId)?.name || "未知医师"} · AI分身` : "选择医师 · AI分身";
  if (route === "physicians" && id === "specialties") return "团队领域概览";
  if (["task", "conversation", "journey", "agent", "physician", "knowledge-item", "connector", "segment"].includes(route)) return entityTitle(route, id);
  return navItems.find(([key]) => key === route)?.[2] || "今日工作台";
};

const navBadge = (key) => {
  if (handoverOnlyMode && key === "workbench") {
    return (store.state.handovers || []).filter((item) => ["pending", "claimed", "active"].includes(item.status)).length;
  }
  if (key === "workbench") return store.state.tasks.filter((task) => !["已完成", "计划中"].includes(task.status)).length;
  if (key === "conversations") return store.state.conversations.reduce((sum, item) => sum + item.unread, 0);
  if (key === "knowledge") return (ui.knowledgeIntakeDocuments || []).filter((item) => item.status === "parsing_pending").length;
  return 0;
};

function shell(content) {
  const { route, id, resourceId } = routeInfo();
  const navRoute = route === "customer" ? "customers" : entityNavRoute(route);
  const visibleNavGroups = handoverOnlyMode
    ? navGroups.map((group) => ({
      ...group,
      items: group.items.filter(([key]) => key === "workbench" || ((knowledgeGovernanceEnabled || knowledgeIntakeEnabled) && key === "knowledge"))
    })).filter((group) => group.items.length)
    : isPresalesWorkspace()
      ? navGroups.map((group) => ({ ...group, items:group.items.filter(([key]) => presalesRouteAllowlist.has(key)) })).filter((group) => group.items.length)
      : navGroups.map(group=>({...group,items:group.items.filter(([key])=>canOpenRouteInCurrentRole(key))})).filter(group=>group.items.length);
  const localRoles = PHASE_ONE_ROLE_LABELS;
  const activeRole = currentPhaseOneRole();
  const activeOperator = (store.state.managementUsers || []).find((item) => item.status === "启用" && normalizePhaseOneRole(item.role) === activeRole);
  const initials = handoverOnlyMode ? "企" : (activeOperator?.nickname || activeOperator?.name || activeRole || "管").slice(0, 1);
  const hasOpenHandover = (store.state.handovers || []).some((item) => ["pending", "claimed", "active"].includes(item.status));
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">美</div><div class="brand-copy"><div class="brand-title">时代之美</div><div class="brand-subtitle">${handoverOnlyMode ? "售前智能体 · 人工接管" : "客户全生命周期智能经营平台"}</div></div></div>
      <nav class="nav" aria-label="后台导航">${visibleNavGroups.map((group) => `<section class="nav-section nav-section-${group.key}" aria-label="${group.label}"><div class="nav-group-label">${handoverOnlyMode ? "真实运营" : group.label}</div>${group.items.map(([key, iconName, label]) => `<button class="nav-item ${navRoute === key ? "active" : ""}" data-nav="${key}" title="${handoverOnlyMode && key === "workbench" ? "人工接管" : label}" aria-label="${handoverOnlyMode && key === "workbench" ? "人工接管" : label}">${icon(iconName, 18)}<span>${handoverOnlyMode && key === "workbench" ? "人工接管" : label}</span>${navBadge(key) ? `<span class="nav-badge">${navBadge(key)}</span>` : ""}</button>`).join("")}</section>`).join("")}</nav>
      <div class="sidebar-bottom">
        <div class="system-health"><button class="link" data-action="connection-details" aria-label="查看服务状态详情">服务状态详情</button><div class="system-health-row"><span class="row"><span class="health-dot"></span>${handoverOnlyMode ? "正式接管模式" : "本地持久化服务"}</span><strong>${ui.operationsError || ui.conversationSyncError || ui.accountError || ui.memberIntegrationError || ui.publicationError || ui.managementPersistenceState === "error" ? "部分服务异常" : ui.managementPersistenceState === "saving" ? "正在保存" : "运行正常"}</strong></div><div class="sync-time">${handoverOnlyMode ? "页面可见时每15秒同步" : ui.managementPersistenceState === "error" ? "最近修改尚未保存" : `最后保存 ${relativeTime(store.state.meta.lastSync)}`}</div></div>
        <div class="sidebar-profile"><div class="avatar" style="display:grid;place-items:center;background:#f0c2cd;color:#6f1f34;font-weight:800">${initials}</div><div><div class="profile-name">${handoverOnlyMode ? "企业实名账号" : activeOperator ? `${escapeHtml(activeOperator.nickname || activeOperator.name)} · ${escapeHtml(activeRole)}` : `本地管理会话 · ${escapeHtml(activeRole)}`}</div><div class="profile-role">${handoverOnlyMode ? "身份与租户由SSO确定" : activeOperator?.department ? escapeHtml(activeOperator.department) : "尚未绑定后台用户"}</div></div></div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="breadcrumb"><span>时代之美</span>${icon("chevron", 12)}<strong>${routeTitle(route, id, resourceId)}</strong></div>
        ${handoverOnlyMode ? `<span class="caption">仅展示已接入服务端并可审计的操作</span>` : `${isPresalesWorkspace() ? `<span class="caption">售前工作台仅展示已进入聊天或已进入接待队列的客户会话</span>` : `<div class="global-search">${icon("search", 17)}<input id="global-search" type="search" placeholder="搜索客户姓名、手机号、档案编号…" autocomplete="off"/><div class="search-results" id="global-results"></div></div>`}<select disabled class="role-select" id="role-select" aria-label="切换角色">${localRoles.map((role) => `<option ${role === activeRole ? "selected" : ""}>${escapeHtml(role)}</option>`).join("")}</select>`}
        ${window.__HUAMEI_MANAGEMENT_RUNTIME__?.browser_session_auth ? `<button class="btn" data-action="admin-logout">退出登录</button>` : ""}
        <button class="topbar-action" data-action="notifications" aria-label="${hasOpenHandover ? "有新的人工接管通知" : "通知"}">${icon("bell", 17)}${hasOpenHandover ? `<span class="notification-dot"></span>` : ""}</button>
      </header>
      <div id="page-content">${content}</div>
    </main>
  </div>`;
}

function workbenchPage() {
  const visibleTasks = store.state.tasks.filter((task) => ui.taskTab === "全部" || (ui.taskTab === "高优先" ? ["紧急", "高"].includes(task.priority) : task.type === ui.taskTab));
  const handovers = Array.isArray(store.state.handovers) ? store.state.handovers : [];
  const openHandovers = handovers.filter((item) => ["pending", "claimed", "active"].includes(item.status));
  const pendingHandovers = openHandovers.filter((item) => item.status === "pending");
  const urgentHandovers = openHandovers.filter((item) => item.priority === "urgent");
  const earliestUrgentSla = urgentHandovers.map((item) => item.sla_due_at).filter(Boolean).sort()[0];
  const activeHandovers = openHandovers.filter((item) => ["claimed", "active"].includes(item.status));
  const overdueHandovers = openHandovers.filter((item) => item.sla_due_at && Date.parse(item.sla_due_at) < Date.now());
  const appointmentIntakes = Array.isArray(ui.appointmentIntakes) ? ui.appointmentIntakes : [];
  const openAppointments = appointmentIntakes.filter((item) => item.status === "registered" && item.followup_status !== "completed");
  const confirmedToday = appointmentIntakes.filter((item) => item.status === "registered" && String(item.confirmed_at || "").slice(0, 10) === new Date().toISOString().slice(0, 10));
  if (handoverOnlyMode) {
    return `<div class="page">${pageHead("人工接管与预约", "人工接管与预约", "这里只展示售前智能体服务端返回的真实接管任务和已确认的预约意向；所有操作均绑定企业实名身份并写入审计记录。",
      `<button class="btn" data-action="refresh" ${ui.operationsLoading ? "disabled" : ""}>${icon("refresh", 15)}${ui.operationsLoading ? "正在同步" : "刷新队列"}</button>`)}
      <div class="grid cols-4" style="margin-bottom:16px">
        ${metric("待接管", String(pendingHandovers.length), "等待实名顾问领取", "bot")}
        ${metric("人工处理中", String(activeHandovers.length), "已由实名顾问接管", "users")}
        ${metric("到院登记待跟进", String(openAppointments.length), ui.appointmentsError ? "预约队列暂时不可读取" : "客户已确认，等待顾问跟进", "calendar")}
        ${metric("今日已登记", String(confirmedToday.length), "客户已确认期望到院时间", "check")}
      </div>
      <section class="card" aria-live="polite"><div class="card-head"><div><div class="card-title">实时接管队列</div><div class="card-subtitle">页面可见时每15秒同步；失败后自动退避，接管与完结采用服务端原子操作</div></div><button class="btn small" data-action="refresh-handovers" ${ui.operationsLoading ? "disabled" : ""}>${icon("refresh",14)}${ui.operationsLoading ? "正在同步" : "刷新"}</button></div>
        ${ui.operationsError
          ? `<div class="risk-banner">${icon("alert",15)}<div><strong>队列暂时无法读取</strong><br/>系统没有展示缓存为成功；请确认企业登录和服务连接后重试。</div></div>`
          : openHandovers.length
            ? `<div class="task-list">${openHandovers.map(handoverRow).join("")}</div>`
            : empty("当前没有待接管会话", "新的强制转人工任务会自动出现在这里")}
      </section>
      ${appointmentQueuePanel(openAppointments)}
      <div class="guardrail" style="margin-top:16px">${icon("shield",14)}客户确认后直接保存到院登记；手机号待人工回电核号。此记录不锁定指定医生或接诊名额，顾问领取后记录跟进结果。</div>
    </div>`;
  }
  const localMetrics = managementOverviewMetrics();
  const activeAgents = store.state.agents.filter((agent) => agent.status !== "已停用").slice(0, 4);
  const funnelRows = [["已建档", localMetrics.customers.length], ["售前", localMetrics.countStage("售前")], ["售中", localMetrics.countStage("售中")], ["售后", localMetrics.countStage("售后")]];
  const funnel = funnelRows.map(([label,value]) => { const rate = localMetrics.customers.length ? Math.round(value / localMetrics.customers.length * 100) : 0; return `<div class="funnel-row"><span>${label}</span><div class="funnel-track"><div class="funnel-fill" style="width:${rate}%">${value}</div></div><strong>${rate}%</strong></div>`; }).join("");
  const agendaItems = localMetrics.openTasks.slice().sort((left, right) => Date.parse(left.dueAt || 0) - Date.parse(right.dueAt || 0)).slice(0, 4);
  return `<div class="page">${pageHead("今日经营概览", "今日工作台", "集中查看今天要跟进的客户、即将超时的任务和建议动作。",
    `<button class="btn" data-action="refresh">${icon("refresh", 15)}刷新数据</button><button class="btn primary" data-action="new-task">${icon("plus", 15)}新建任务</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">
      ${metric("待推进客户", String(localMetrics.customers.length), "当前系统已建档", "users")}${metric("即将超时的任务", String(localMetrics.overdueTasks.length), "按本地任务时限统计", "clock")}
      ${metric("待人工接管的AI会话", String(pendingHandovers.length), `实时开放 ${openHandovers.length} 条`, "bot")}${metric("到院登记待跟进", String(openAppointments.length), ui.appointmentsError ? "预约队列暂时不可读取" : `今日已登记 ${confirmedToday.length} 条`, "calendar")}
    </div>
    <section class="card" style="margin-bottom:16px" aria-live="polite"><div class="card-head"><div><div class="card-title">人工接管实时队列</div><div class="card-subtitle">页面可见时自动刷新；接管、原子完结和工时均写入服务端审计记录</div></div><button class="btn small" data-action="refresh-handovers" ${ui.operationsLoading ? "disabled" : ""}>${icon("refresh",14)}${ui.operationsLoading ? "正在同步" : "刷新队列"}</button></div>
      ${ui.operationsError
        ? `<div class="risk-banner">${icon("alert",15)}<div><strong>队列暂时无法读取</strong><br/>请确认已完成企业实名登录，或稍后重试。</div></div>`
        : openHandovers.length
          ? `<div class="task-list">${openHandovers.map(handoverRow).join("")}</div>`
          : empty("当前没有待接管会话", "新的强制转人工任务会自动出现在这里")}
    </section>
    ${appointmentQueuePanel(openAppointments)}
    <div class="grid dashboard-layout">
      <div class="stack">
        <section class="card"><div class="card-head"><div><div class="card-title">今日优先任务</div><div class="card-subtitle">按客户、待解决问题和预期结果安排跟进</div></div>
          <div class="priority-tabs">${["全部", "高优先", "AI转人工", "AI审批"].map((tab) => `<button class="tab-btn ${ui.taskTab === tab ? "active" : ""}" data-action="task-tab" data-id="${tab}">${tab === "AI审批" ? "待人工确认" : tab === "AI转人工" ? "待人工接手" : tab}</button>`).join("")}</div></div>
          <div class="task-list">${visibleTasks.length ? visibleTasks.map(taskRow).join("") : empty("当前队列为空", "切换其他筛选条件查看任务")}</div>
        </section>
        <div class="grid cols-2">
          ${card("服务阶段分布", `<div class="funnel">${funnel}</div>`, { subtitle: "当前系统已建档客户", action: `<button class="link" data-nav="analytics">查看分析</button>` })}
          ${card("任务推进概览", `<div class="row between"><div><strong style="font-size:19px">${localMetrics.openTasks.length}</strong><div class="caption">待完成任务</div></div>${badge(`${localMetrics.tasks.filter((item) => item.status === "已完成").length} 已完成`, "success")}</div><div class="divider"></div><div class="caption">仅统计当前系统内任务；不使用外部系统或历史演示数据。</div>`, { subtitle: "统一任务状态口径" })}
        </div>
      </div>
      <div class="stack">
        ${card("待办安排", agendaItems.length ? agendaItems.map((task) => `<div class="agenda-row"><div class="agenda-time">${formatDate(task.dueAt)}</div><div><div class="agenda-title">${escapeHtml(task.title)}</div><div class="agenda-meta">${escapeHtml(task.assignee || "待分配")} · ${escapeHtml(task.status || "待处理")}</div></div><span class="spacer"></span>${icon("chevron",14)}</div>`).join("") : empty("暂无待办安排", "创建任务后会在这里显示"), { action: `<button class="link" data-action="agenda">完整日程</button>` })}
        ${card("AI员工运行情况", activeAgents.map((agent) => `<div class="agent-mini"><div class="agent-icon" style="width:32px;height:32px;border-radius:10px">${icon("bot",16)}</div><div style="min-width:0;flex:1"><div class="row between"><strong style="font-size:11px">${agent.name}</strong>${badge(agent.status === "灰度中" ? "试运行" : agent.status)}</div><div class="agenda-meta">当前服务 ${agent.runtimeActiveCustomers || 0} 位客户 · 关联会话 ${agent.runtimeConversationCount || 0} 条 · 待办 ${agent.runtimeOpenTaskCount || 0} 项</div></div></div>`).join(""), { subtitle: "客户、会话与任务的当前关联", action: `<button class="link" data-nav="agents">管理AI员工</button>` })}
        ${card("风险与异常", urgentHandovers.length
          ? `<div class="risk-banner">${icon("alert",16)}<div><strong>${urgentHandovers.length} 条紧急会话等待处理</strong><br/>最早 SLA：${earliestUrgentSla ? escapeHtml(formatDate(earliestUrgentSla)) : "待确认"}</div></div><div class="row between"><span class="caption">全部开放接管</span>${badge(String(openHandovers.length), "warning")}</div>`
          : openHandovers.length
            ? `<div class="row between"><span class="caption">开放人工接管</span>${badge(String(openHandovers.length), "warning")}</div><div class="caption" style="margin-top:10px">当前没有紧急级别任务，队列会在页面可见时自动更新。</div>`
            : `<div class="row between"><span class="caption">实时接管异常</span>${badge("0", "success")}</div><div class="caption" style="margin-top:10px">当前没有来自售前智能体的开放接管任务。</div>`, { action: `<button class="link" data-action="refresh-handovers">刷新实时队列</button>` })}
      </div>
    </div>
  </div>`;
}

const handoverReasonLabel = (reason = "") => ({
  medical_emergency:"紧急医疗风险",
  critical_risk_continuity:"高风险连续沟通",
  medical_safety:"医疗安全边界",
  human_requested:"客户要求人工",
  low_confidence:"智能体信心不足"
}[reason] || String(reason || "需要人工处理").replaceAll("_", " "));

const handoverStatusLabel = (status = "") => ({ pending:"待接管", claimed:"人工处理中", active:"人工处理中", completed:"已完结" }[status] || status);
const handoverPendingFieldLabel = (field = "") => ({
  preferred_project:"意向项目", preferred_project_or_concern:"项目或改善诉求",
  preferred_date:"到院日期", time_preference:"方便联系/到院时段",
  human_owner:"人工负责人", preferred_doctor:"意向医生", budget:"预算"
}[field] || String(field || "").replaceAll("_", " "));
const handoverIntentLabel = (intent = "") => ({
  project_explanation:"了解项目", project_comparison:"比较项目", physician_discovery:"了解医生",
  appointment_query:"咨询预约", appointment_request:"提交预约", price_query:"咨询价格",
  human_handover:"申请人工", complaint:"投诉处理", medical_safety:"医疗安全处理",
  need_clarification:"待澄清需求"
}[intent] || "继续处理本次咨询");

function handoverRow(handover) {
  const overdue = handover.sla_due_at && Date.parse(handover.sla_due_at) < Date.now();
  const active = ["claimed", "active"].includes(handover.status);
  const projects = Array.isArray(handover.projects) ? handover.projects.slice(0, 3) : [];
  const doctors = Array.isArray(handover.doctors) ? handover.doctors.slice(0, 2) : [];
  const pending = Array.isArray(handover.pending_fields) ? handover.pending_fields.slice(0, 4).map(handoverPendingFieldLabel) : [];
  const goal = handover.conversation_goal?.intent ? `当前目标：${handoverIntentLabel(handover.conversation_goal.intent)}` : "";
  const detail = [
    projects.length ? `项目：${projects.join("、")}` : "",
    doctors.length ? `医生：${doctors.join("、")}` : "",
    pending.length ? `待补：${pending.join("、")}` : "",
    goal
  ].filter(Boolean).join(" · ");
  return `<div class="task-row"><span class="task-priority ${handover.priority === "urgent" ? "紧急" : "高"}"></span><div><div class="task-title">${escapeHtml(handoverReasonLabel(handover.reason))}</div><div class="task-meta"><span>${escapeHtml(handover.channel || "未知渠道")}</span><span>会话 ${escapeHtml(handover.conversation_id || "未记录")}</span><span>${escapeHtml(handover.team || "人工咨询")}</span>${badge(handoverStatusLabel(handover.status), active ? "warning" : "danger")}</div><div class="caption" style="margin-top:5px">${escapeHtml(handover.summary || "待人工查看会话摘要")}</div>${detail ? `<div class="caption" style="margin-top:4px">${escapeHtml(detail)}</div>` : ""}</div><div class="task-due"><div class="${overdue ? "overdue" : "caption"}">${overdue ? "已超过接管SLA" : handover.sla_due_at ? `SLA ${formatDate(handover.sla_due_at)}` : "SLA 待确认"}</div><div class="caption" style="margin-top:3px">${handover.assignee ? `接管人：${escapeHtml(handover.assignee)}` : "尚未分配"}</div></div><div class="row">${handover.status === "pending" ? `<button class="btn small primary" data-action="claim-handover" data-id="${handover.id}">立即接管</button>` : active ? `<button class="btn small" data-action="reveal-contact" data-id="${handover.id}">查看联系方式</button><button class="btn small primary" data-action="complete-handover" data-id="${handover.id}">完结并登记工时</button>` : badge("已完结", "success")}</div></div>`;
}

const appointmentStatusLabel = (status = "") => ({ registered:"已登记", pending:"待跟进", claimed:"跟进中", needs_customer_info:"待补充信息", completed:"跟进完成", cancelled:"已取消" }[status] || status);

function appointmentQueuePanel(openAppointments = []) {
  return `<section class="card" style="margin-top:16px" aria-live="polite"><div class="card-head"><div><div class="card-title">到院登记待跟进</div><div class="card-subtitle">展示最近200条登记中的待跟进事项；顾问领取后回电核号并记录跟进结果。</div></div><button class="btn small" data-action="refresh-appointments" ${ui.appointmentsLoading ? "disabled" : ""}>${icon("refresh",14)}${ui.appointmentsLoading ? "正在同步" : "刷新"}</button></div>
    ${ui.appointmentsError ? `<div class="risk-banner">${icon("alert",15)}<div><strong>登记队列暂时无法读取</strong><br/>请稍后刷新。</div></div>` : openAppointments.length ? `<div class="task-list">${openAppointments.map(appointmentRow).join("")}</div>` : empty("当前没有待跟进的到院登记", "客户新登记或改期后将自动进入跟进队列")}
  </section>`;
}

function appointmentRow(intake) {
  const project = (intake.projects || []).join("、") || "项目待补充";
  const action = intake.assignee ? `<button class="btn small primary" data-action="resolve-appointment" data-id="${intake.id}">记录跟进</button><button class="btn small" data-action="reveal-appointment-contact" data-id="${intake.id}">查看回拨号码</button>` : `<button class="btn small primary" data-action="claim-appointment" data-id="${intake.id}">领取跟进</button>`;
  return `<div class="task-row"><span class="task-priority ${intake.assignee ? "普通" : "高"}"></span><div><div class="task-title">${escapeHtml(project)}${intake.doctor ? ` · ${escapeHtml(intake.doctor)}医生` : ""}</div><div class="task-meta"><span>${escapeHtml(intake.branch || "")}</span><span>${escapeHtml(intake.time_preference || "")}</span>${badge(appointmentStatusLabel(intake.followup_status), intake.assignee ? "brand" : "warning")}</div><div class="caption" style="margin-top:5px">会话 ${escapeHtml(intake.conversation_id || "")} · 手机号已保存，待回电核号 · 登记号 ${escapeHtml(intake.appointment_no || "")}</div></div><div class="task-due"><div class="caption">${formatDate(intake.updated_at)}</div><div class="caption">${intake.assignee ? `跟进人：${escapeHtml(intake.assignee)}` : "尚未领取"}</div></div><div class="row">${action}</div></div>`;
}

function taskRow(task) {
  const customer = store.customer(task.customerId);
  const overdue = new Date(task.dueAt) < new Date() && task.status !== "已完成";
  const taskTypeLabel = task.type === "AI转人工" ? "待人工接手" : task.type === "AI审批" ? "待人工确认" : task.type;
  return `<div class="task-row"><span class="task-priority ${task.priority}"></span><div><button class="link task-title" data-entity="task" data-id="${task.id}">${escapeHtml(task.title)}</button><div class="task-meta"><button class="link" data-customer="${customer.id}">${customer.name}</button><span>${customer.macroStage} · ${customer.microStage}</span><span>${task.assignee}</span>${badge(taskTypeLabel, task.type === "AI转人工" ? "danger" : "")}</div></div><div class="task-due"><div class="${overdue ? "overdue" : "caption"}">${overdue ? "已超时" : formatDate(task.dueAt)}</div><div class="caption" style="margin-top:3px">${task.reason}</div></div><div class="row"><button class="btn small ghost" data-entity="task" data-id="${task.id}">详情</button>${task.status === "已完成" ? badge("已完成", "success") : `<button class="btn small ${task.priority === "紧急" ? "primary" : ""}" data-action="complete-task" data-id="${task.id}">完成</button>`}</div></div>`;
}

const conversationStatusLabel = (status) => ({
  "AI处理中":"AI协助中",
  "人工处理中":"人工跟进中",
  "待审批":"待人工确认"
}[status] || status);

function customersPage() {
  const metrics = managementOverviewMetrics();
  const query = ui.customerQuery.trim().toLowerCase();
  const customers = store.state.customers.map(customerPresentation).filter((customer) => {
    const matchesQuery = !query || [customer.name, customer.mobile, customer.id, customer.source, customer.owner, ...customer.tags].join(" ").toLowerCase().includes(query);
    return matchesQuery && (ui.customerStage === "全部" || customer.macroStage === ui.customerStage) && (ui.customerOwner === "全部负责人" || customer.owner === ui.customerOwner);
  });
  const presales = isPresalesWorkspace();
  const actions = presales ? "" : `<button class="btn" data-action="segment">${icon("filter",15)}创建动态分群</button><button class="btn primary" data-action="new-customer">${icon("plus",15)}新增客户</button>`;
  return `<div class="page">${pageHead(presales ? "客户会话" : "客户经营", presales ? "已进入聊天的客户" : "客户经营", presales ? "仅展示已进入聊天或接待队列的客户；选择客户后直接进入对应会话，不提供客户画像、阶段、归属或旅程维护。" : "统一查看客户阶段、兴趣、负责人、建议动作与分群，让每次跟进都有清晰依据。", actions)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("统一客户档案", String(metrics.customers.length), "当前系统已建档", "users")}${metric("售前客户", String(metrics.countStage("售前")), "按统一阶段口径", "spark")}${metric("售中客户", String(metrics.countStage("售中")), "按统一阶段口径", "calendar")}${metric("售后活跃", String(metrics.countStage("售后")), `复购窗口 ${metrics.customers.filter((item) => item.microStage === "复购窗口").length}`, "refresh")}</div>
    <section class="card">
      <div class="card-head"><div class="toolbar" style="margin:0"><div class="search-field">${icon("search",16)}<input id="customer-search" aria-label="搜索客户" class="field" value="${escapeHtml(ui.customerQuery)}" placeholder="搜索客户、标签、负责人…"/></div><select class="select" id="customer-stage" aria-label="按阶段筛选"><option>全部</option>${["售前","售中","售后"].map((stage) => `<option ${ui.customerStage === stage ? "selected" : ""}>${stage}</option>`).join("")}</select><select class="select" id="customer-owner" aria-label="按负责人筛选"><option>全部负责人</option>${[...new Set(store.state.customers.map(item=>item.owner).filter(Boolean))].map(owner=>`<option ${ui.customerOwner === owner ? "selected" : ""}>${escapeHtml(owner)}</option>`).join("")}</select>${badge(`当前 ${customers.length} 位`)}</div>
        <div class="segmented view-toggle"><button class="tab-btn ${ui.customerView === "table" ? "active" : ""}" data-action="customer-view" data-id="table">列表</button><button class="tab-btn ${ui.customerView === "board" ? "active" : ""}" data-action="customer-view" data-id="board">阶段看板</button></div></div>
      ${ui.customerView === "table" ? customerTable(customers) : customerBoard(customers)}
    </section>
  </div>`;
}

function customerTable(customers) {
  if (!customers.length) return empty("没有匹配客户", "请调整搜索或筛选条件");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>客户</th><th>阶段/当前环节</th><th>项目兴趣</th><th>建议动作</th><th>负责人/AI协作</th><th>服务时限</th><th>意向评分</th><th></th></tr></thead><tbody>${customers.map((customer) => `<tr><td>${customerCell(customer)}</td><td>${badge(customer.macroStage)}<div class="customer-meta">${customer.microStage}</div></td><td><strong>${(customer.interests[0]?.name || "项目待确认")}</strong><div class="interest-row" style="width:120px"><div class="interest-track"><div class="interest-fill" style="width:${(customer.interests[0]?.score ?? "—")}%"></div></div><span>${(customer.interests[0]?.score ?? "—")}</span></div></td><td style="max-width:250px"><strong style="font-size:11px">${customer.nextAction.title}</strong><div class="customer-meta">${customer.nextAction.status} · ${customer.nextAction.channel}</div></td><td><strong>${customer.owner}</strong><div class="customer-meta">${customer.agent}</div></td><td class="${customer.sla.includes("超时") ? "overdue" : ""}">${customer.sla}</td><td><span class="score ${customer.score >= 80 ? "high" : customer.score >= 60 ? "mid" : ""}">${customer.score}</span></td><td><button class="btn small" data-customer="${customer.id}">客户360 ${icon("arrow",13)}</button></td></tr>`).join("")}</tbody></table></div>`;
}

function customerBoard(customers) {
  return `<div class="card-body"><div class="board">${["售前","售中","售后"].map((stage) => { const stageCustomers = customers.filter((customer) => customer.macroStage === stage); return `<div class="board-column"><div class="board-head"><span class="board-title">${stage}</span>${badge(`${stageCustomers.length}人`, stage)}</div>${stageCustomers.map((customer) => `<article class="customer-board-card" data-customer="${customer.id}"><div class="row">${avatar(customer,"sm")}<div><strong>${customer.name}</strong><div class="customer-meta">${customer.microStage} · ${customer.owner}</div></div><span class="spacer"></span><strong class="score ${customer.score >= 80 ? "high" : "mid"}">${customer.score}</strong></div><div class="divider" style="margin:10px 0"></div><div class="caption">${customer.nextAction.title}</div><div class="row between" style="margin-top:8px">${badge((customer.interests[0]?.name || "项目待确认"),"brand")}<span class="caption ${customer.sla.includes("超时") ? "overdue" : ""}">${customer.sla}</span></div></article>`).join("") || `<div class="empty">暂无客户</div>`}</div>`; }).join("")}</div></div>`;
}

function customer360Page(customerId) {
  if (isPresalesWorkspace()) {
    const conversation = (store.state.conversations || []).find((item) => item.customerId === customerId);
    if (!conversation) return `<div class="page">${pageHead("客户会话", "未进入接待队列", "该客户当前没有可由售前人员处理的会话。")}<section class="card">${empty("暂无可接待会话", "请在会话与接待中处理已进入聊天队列的客户。")}</section></div>`;
    ui.conversationId = conversation.id;
    return conversationsPage();
  }
  const rawCustomer = store.customer(customerId) || store.state.customers[0];
  if (!rawCustomer) return empty("暂无客户资料", "请返回客户列表选择客户");
  const customer = customerPresentation(rawCustomer);
  const visiblePhoto = customer.photoConsent !== "已撤回";
  const timeline = customer.timeline.filter((event) => ui.timelineFilter === "全部" || event.type === ui.timelineFilter);
  const steps = stageSteps[customer.macroStage] || [];
  const stepIndex = Math.max(0, steps.indexOf(customer.microStage));
  const actions = `<button class="btn" data-action="create-customer-task" data-id="${customer.id}">${icon("plus",15)}创建任务</button><button class="btn" data-action="send-from-customer" data-id="${customer.id}">${icon("message",15)}进入会话</button><button class="btn primary" data-action="update-stage" data-id="${customer.id}">${icon("route",15)}推进阶段</button>`;
  return `<div class="page">${pageHead("客户全景档案", "客户360", "集中查看客户阶段、兴趣、沟通记录、负责人和下一步建议。", actions)}
    <section class="card customer360-head"><div class="photo-wrap">${avatar(customer,"lg")}<span class="badge photo-consent ${visiblePhoto ? "success" : "danger"}">${customer.photoConsent}</span></div><div><div class="identity-title"><h1>${customer.name}</h1>${badge(customer.macroStage)}${customer.tags.slice(0,3).map((tag) => badge(tag,"outline")).join("")}</div><div class="identity-meta"><span>${customer.gender} · ${customer.age ? `${customer.age}岁` : "年龄待补充"}</span><span>${customer.mobile}</span><span>${customer.city}</span><span>来源：${customer.source}</span><span>档案编号：${customer.id}</span></div></div><div class="identity-actions"><button class="btn small" data-action="call" data-id="${customer.id}">${icon("phone",14)}电话</button><button class="btn small" data-action="edit-profile" data-id="${customer.id}">${icon("edit",14)}编辑画像</button><button class="btn small" data-action="photo-consent" data-id="${customer.id}">${icon("eye",14)}照片授权</button></div></section>
    <section class="card lifecycle"><div class="lifecycle-top"><div><div class="card-title">客户生命周期</div><div class="card-subtitle">当前环节：${customer.microStage} · 进入于 ${formatDate(customer.stageEnteredAt)}</div></div><div class="row">${badge(customer.sla, customer.sla.includes("超时") ? "danger" : "success")}<button class="link" data-action="stage-history" data-id="${customer.id}">查看阶段历史</button></div></div><div class="stage-rail">${["售前","售中","售后"].map((stage, index) => `<div class="stage-block ${customer.macroStage === stage ? "active" : ""}" style="--progress:${customer.macroStage === stage ? ((stepIndex + 1) / Math.max(1, steps.length)) * 100 : index < ["售前","售中","售后"].indexOf(customer.macroStage) ? 100 : 0}%"><div class="stage-name">${index + 1}. ${stage}</div><div class="stage-detail">${customer.macroStage === stage ? `${customer.microStage} · ${stepIndex + 1}/${steps.length}` : stage === "售前" ? "咨询 → 预约" : stage === "售中" ? "到院 → 项目完成" : "随访 → 复购/转介绍"}</div></div>`).join("")}</div></section>
    <div class="grid cols-4 customer-kpis">${metric("意向评分", customer.score, `主要兴趣：${(customer.interests[0]?.name || "项目待确认")}`, "spark")}${metric("经营健康度", customer.health, customer.health >= 80 ? "关系稳定" : "需要关注", "shield")}${metric("阶段停留", Math.max(1, Math.round((Date.now() - new Date(customer.stageEnteredAt)) / 86400000)), "请关注服务时限", "clock", "天")}${metric("最近渠道", customer.latestChannel, relativeTime(customer.timeline[0]?.occurredAt), "message")}</div>
    <div class="grid customer360-grid">
      <div class="stack">${profileCard(customer)}${interestCard(customer)}${pidCard(customer)}</div>
      <div class="stack">${nbaCard(customer)}${timelineCard(customer, timeline)}</div>
      <div class="stack">${responsibilityCard(customer)}${journeyCard(customer)}${riskConsentCard(customer)}</div>
    </div>
  </div>`;
}

function profileCard(customer) {
  const memberCheck = memberCheckPresentation(customer.memberCheck);
  const phoneVerification = customer.phoneVerificationStatus === "verified" ? "已人工核号" : "待人工核号";
  return card("客户画像", `<div class="row between" style="margin-bottom:11px"><span class="caption">信息完整度 ${customer.profile.confidence}% · 新信息会自动补充</span>${badge("持续更新", "ai")}</div><div class="profile-list">${Object.entries({"预算区间":customer.profile.budget,"决策方式":customer.profile.decision,"联系偏好":customer.profile.contact,"沟通风格":customer.profile.style,"核心顾虑":customer.profile.concern}).map(([key,value]) => `<div class="profile-row"><span class="profile-key">${key}</span><span class="profile-value">${value}</span></div>`).join("")}</div><div class="divider"></div><div class="profile-row"><span class="profile-key">手机号状态</span><span class="profile-value">${escapeHtml(phoneVerification)}</span></div><div class="divider"></div><div class="profile-row"><span class="profile-key">院方身份核验</span><span class="profile-value">${escapeHtml(memberCheck.label)}${memberCheck.checkedAt ? `<br><span class="caption">查询时间：${escapeHtml(formatDate(memberCheck.checkedAt))}</span>` : ""}</span></div><div class="divider"></div><div class="tag-list">${customer.tags.map((tag) => badge(tag,"outline")).join("")}</div>`, { action: `<button class="link" data-action="edit-profile" data-id="${customer.id}">编辑</button>` });
}

function interestCard(customer) {
  return card("项目兴趣", customer.interests.map((item) => `<div class="interest-row"><span class="interest-name">${item.name}</span><div class="interest-track"><div class="interest-fill" style="width:${item.score}%"></div></div><strong>${item.score}</strong><span class="caption ${item.trend.startsWith("+") ? "" : item.trend.startsWith("-") ? "overdue" : ""}">${item.trend}</span></div>`).join(""), { subtitle: "来源：会话、浏览、预约和人工确认" });
}

function pidCard(customer) {
  return card("痛点 · 痒点 · 爽点", `<div class="pid-grid"><div class="pid-box pain"><div class="pid-label" style="color:var(--danger)">痛点</div>${customer.pains.map((item) => `<div class="pid-item">• ${item}</div>`).join("")}</div><div class="pid-box itch"><div class="pid-label" style="color:var(--warning)">痒点</div>${customer.itches.map((item) => `<div class="pid-item">• ${item}</div>`).join("")}</div><div class="pid-box delight"><div class="pid-label" style="color:var(--success)">爽点</div>${customer.delights.map((item) => `<div class="pid-item">• ${item}</div>`).join("")}</div></div>`, { subtitle: "内容来自客户沟通与行为记录，信息不足时需人工确认" });
}

function nbaCard(customer) {
  const action = customer.nextAction;
  return `<section class="nba-card"><div class="nba-kicker">${icon("spark",14)} 下一步建议</div><div class="nba-title">${action.title}</div><div class="nba-reason">${action.reason}</div><div class="nba-meta"><div class="mini-stat"><div class="mini-stat-label">责任人</div><div class="mini-stat-value">${action.owner}</div></div><div class="mini-stat"><div class="mini-stat-label">渠道 / 时机</div><div class="mini-stat-value">${action.channel} · ${formatDate(action.dueAt)}</div></div><div class="mini-stat"><div class="mini-stat-label">状态</div><div class="mini-stat-value">${action.status}</div></div></div><div class="guardrail">${icon("shield",14)}<span>${action.guardrail}</span></div><div class="row" style="margin-top:13px"><button class="btn primary" data-action="execute-nba" data-id="${customer.id}">${icon("arrow",14)}执行建议</button><button class="btn" data-action="replace-nba" data-id="${customer.id}">调整策略</button><button class="btn ghost" data-action="nba-evidence" data-id="${customer.id}">查看证据</button></div></section>`;
}

function timelineCard(customer, timeline) {
  const sourceLabel = (value) => ({ "画像引擎":"客户画像", "百度连接器":"渠道数据", "规则引擎":"业务规则" }[value] || value);
  const titleLabel = (value) => value === "动态画像更新" ? "客户画像更新" : value;
  return card("完整时间线", `<div class="timeline-filter">${["全部","conversation","profile","task","risk","appointment","treatment","followup","consent"].map((filter) => `<button class="tab-btn ${ui.timelineFilter === filter ? "active" : ""}" data-action="timeline-filter" data-id="${filter}">${({conversation:"会话",profile:"画像",task:"任务",risk:"风险",appointment:"预约",treatment:"项目",followup:"随访",consent:"授权"})[filter] || filter}</button>`).join("")}</div><div class="timeline">${timeline.length ? timeline.map((event) => `<article class="timeline-event"><span class="timeline-dot ${event.tone || ""}"></span><div class="timeline-title">${escapeHtml(titleLabel(event.title))}</div><div class="timeline-time">${formatDate(event.occurredAt)} · ${escapeHtml(sourceLabel(event.actor))} · ${escapeHtml(sourceLabel(event.channel))}</div><div class="timeline-detail">${escapeHtml(event.detail)}</div></article>`).join("") : empty("暂无该类事件", "切换其他时间线筛选")}</div>`, { subtitle: "按时间汇总客户沟通、员工操作和系统记录", action: `<button class="link" data-action="export-timeline" data-id="${customer.id}">${icon("download",13)} 导出摘要</button>` });
}

function responsibilityCard(customer) {
  return card("当前责任链", `<div class="responsibility"><div class="responsibility-row"><div class="responsibility-icon">${icon("users",16)}</div><div><div class="responsibility-name">${customer.owner}</div><div class="responsibility-role">客户负责人 · 负责最终跟进</div></div></div><div class="responsibility-row"><div class="responsibility-icon">${icon("bot",16)}</div><div><div class="responsibility-name">${customer.agent}</div><div class="responsibility-role">协作AI · 在授权范围内协助跟进</div></div></div><div class="responsibility-row"><div class="responsibility-icon">${icon("shield",16)}</div><div><div class="responsibility-name">合规守门员</div><div class="responsibility-role">合规检查 · 发现风险时阻止发送并转人工</div></div></div></div>`, { action: `<button class="link" data-action="reassign" data-id="${customer.id}">变更责任人</button>` });
}

function journeyCard(customer) {
  return card("当前旅程与任务", customer.journeys.map((journey) => `<div class="journey-chip"><div class="row between"><strong style="font-size:11px">${journey.name}</strong>${badge(journey.status)}</div><div class="journey-node">当前节点：${journey.node}</div></div>`).join("") + `<div class="divider"></div>${store.state.tasks.filter((task) => task.customerId === customer.id && task.status !== "已完成").map((task) => `<div class="row between" style="margin:8px 0"><span class="caption">${task.title}</span>${badge(task.status, task.priority === "紧急" ? "danger" : "")}</div>`).join("") || `<div class="caption">当前无待办任务</div>`}`, { action: `<button class="link" data-action="add-journey" data-id="${customer.id}">加入旅程</button>` });
}

function riskConsentCard(customer) {
  const serviceConsent = customer.serviceConsent === true || customer.serviceConsent === "已授权" ? "已授权" : "未授权";
  const marketingConsent = customer.marketingConsent === true || customer.tags.includes("营销授权有效") ? "已授权" : "未授权";
  return card("授权与风险", `<div class="profile-list"><div class="profile-row"><span class="profile-key">客户服务</span><span>${badge(serviceConsent, serviceConsent === "已授权" ? "success" : "danger")}</span></div><div class="profile-row"><span class="profile-key">营销触达</span><span>${badge(marketingConsent, marketingConsent === "已授权" ? "success" : "warning")}</span></div><div class="profile-row"><span class="profile-key">客户照片</span><span>${badge(customer.photoConsent, customer.photoConsent === "已授权" ? "success" : "danger")}</span></div><div class="profile-row"><span class="profile-key">医疗风险</span><span>${badge(customer.timeline.some((event) => event.type === "risk") ? "有边界记录" : "未触发", customer.timeline.some((event) => event.type === "risk") ? "danger" : "success")}</span></div></div><div class="divider"></div><div class="caption">敏感数据仅在授权范围、角色权限和业务目的内展示；每次查看与导出均记录审计。</div>`, { action: `<button class="link" data-action="consent-detail" data-id="${customer.id}">授权详情</button>` });
}

const linkedHandoverForConversation = (conversation) => (store.state.handovers || []).find((handover) =>
  handover.conversation_id === (conversation.externalConversationId || conversation.id)
  && ["pending", "claimed", "active"].includes(handover.status));

const commonPhraseRecords = () => (store.state.configurationRecords || [])
  .filter((item) => item.kind === "message_template"
    && item.status === "启用"
    && item.presalesVisible !== false
    && item.content);

const handoverAssigneeDisplay = (handover) => {
  if (!handover) return { title:"机器人服务中", detail:"当前没有人工接管任务" };
  if (handover.status === "pending") return { title:"待售前人员接管", detail:"AI仍受规则约束，等待实名顾问领取" };
  const identity = String(handover.assignee || "").trim();
  const operator = (store.state.managementUsers || []).find((item) => [item.id, item.account, item.staffId]
    .filter(Boolean).includes(identity));
  const nickname = operator?.nickname || operator?.name || identity || "实名售前人员";
  const staffId = operator?.staffId || operator?.account || identity || "待同步";
  return { title:nickname, detail:`ID：${staffId}` };
};

const channelStatusLabel = (channel = {}) => {
  if (channel.id === "web" && channel.status === "ready") return "已就绪";
  if (channel.status === "configured") return "待官方回调验收";
  if (channel.status === "misconfigured") return "配置不完整";
  if (channel.status === "not_configured") return "待连接";
  if (channel.status === "ready") return "已就绪";
  return "状态读取中";
};

const phaseOneImChannels = () => {
  const fromService = new Map((ui.acquisitionChannelStatuses || []).map((item) => [item.id, item]));
  return [
    { id:"wecom", name:"企业微信" },
    { id:"douyin", name:"抖音私信" },
    { id:"xiaohongshu", name:"小红书私信" }
  ].map((fallback) => ({ ...fallback, ...(fromService.get(fallback.id) || {}) }));
};

function acquisitionConversationControls(conversation, customer) {
  if (customer.origin !== "acquisition_advisor") {
    if (isPresalesWorkspace()) return badge("内部登记会话", "outline");
    return `<div class="segmented"><button class="tab-btn ${conversation.mode === "AI" || conversation.mode === "AI辅助" ? "active" : ""}" data-action="conversation-mode" data-id="AI辅助">机器人接管</button><button class="tab-btn ${conversation.mode === "人工" ? "active" : ""}" data-action="conversation-mode" data-id="人工">人工接管</button></div>`;
  }
  const handover = linkedHandoverForConversation(conversation);
  if (!handover) return badge("无开放接管任务", "outline");
  if (handover.status === "pending") return `<button class="btn small primary" data-action="claim-handover" data-id="${handover.id}">人工接管</button>`;
  return `<button class="btn small" data-action="robot-takeover" data-id="${handover.id}">机器人接管</button><button class="btn small primary" data-action="complete-handover" data-id="${handover.id}">记录跟进 / 完结</button>`;
}

function acquisitionConversationComposer(conversation, customer) {
  if (customer.origin !== "acquisition_advisor") {
    if (isPresalesWorkspace()) {
      return `<div class="chat-compose"><div class="risk-banner" style="width:100%;margin:0">${icon("shield",15)}<div><strong>该会话是内部历史登记记录</strong><br/>售前人员只能在已接入的实名 IM 会话中接管和回复；此处不写入全局运营数据，也不会对外发送消息。</div></div></div>`;
    }
    const enabledTemplate = (store.state.configurationRecords || []).find((item) => item.kind === "message_template" && item.status === "启用" && item.content);
    const publishedKnowledge = (store.state.knowledge || []).find((item) => item.status === "已发布" && item.customerFacing !== false && item.allowedForCustomerResponse !== false && item.excerpt);
    const canRecordHumanContact = conversation.mode === "人工";
    return `<div class="chat-compose"><div class="compose-box"><textarea id="message-input" placeholder="登记已完成的人工沟通内容；本期不会向任何外部渠道发送消息。"></textarea><div class="compose-actions"><button class="btn small ghost" data-action="insert-template" ${enabledTemplate ? "" : "disabled"}>插入已启用话术</button><button class="btn small ghost" data-action="insert-knowledge" ${publishedKnowledge ? "" : "disabled"}>引用已发布知识</button><span class="spacer"></span>${badge(conversation.mode,"ai")}<button class="btn small primary" data-action="send-message" data-id="${conversation.id}" ${canRecordHumanContact ? "" : "disabled"}>登记沟通记录 ${icon("check",13)}</button></div><div class="caption" style="margin-top:8px">${canRecordHumanContact ? "仅登记运营人员已在获批渠道完成的沟通事实；不会触发对客发送。" : "请先切换为人工接管；AI辅助在当前阶段只可生成参考，不可对外发送。"}</div></div></div>`;
  }
  const handover = linkedHandoverForConversation(conversation);
  const action = !handover
    ? ""
    : handover.status === "pending"
      ? `<button class="btn small primary" data-action="claim-handover" data-id="${handover.id}">接管并停止AI对外发送</button>`
      : `<button class="btn small" data-action="robot-takeover" data-id="${handover.id}">机器人接管并登记</button>`;
  return `<div class="chat-compose"><div class="compose-box"><label class="caption" for="message-input">回复草稿 · 不会自动发送</label><textarea id="message-input" maxlength="4000" placeholder="输入回复，或从右侧插入常用话术。复制后请在已批准渠道确认发送。"></textarea><div class="compose-actions"><span class="caption">仅在当前页面临时保存</span><span class="spacer"></span><button class="btn small primary" data-action="copy-reply-draft">复制回复</button></div></div><div class="risk-banner" style="width:100%;margin:8px 0 0">${icon("shield",15)}<div><strong>人工跟进使用电话或已批准的 IM 渠道</strong><br/><details><summary>渠道尚未开放直接发送 · 查看说明</summary>当前仅完成统一通道协议。企业微信、抖音、小红书在完成官方凭证、回调验签和发送验收前，不会把草稿或话术标记为“已发送”。</details></div><span class="spacer"></span>${action}</div></div>`;
}

function conversationsPage() {
  const groupOf = item => {
    const task = linkedHandoverForConversation(item);
    return /结束|关闭|完成/.test(item.status || '') ? '已结束' : task?.status === 'pending' || item.status === '待人工' ? '待人工' : task?.status === 'claimed' || item.mode === '人工' ? '人工接待' : '机器人';
  };
  const conversations = store.state.conversations.filter(item => ui.conversationFilter === "全部" || groupOf(item) === ui.conversationFilter || item.status.includes(ui.conversationFilter)).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  const current = store.conversation(ui.conversationId) || conversations[0] || store.state.conversations[0];
  if (current) ui.conversationId = current.id;
  if (!current) {
    return `<div class="page">${pageHead("客户沟通", "会话与接待", "当前没有已接入的客户会话。前台咨询记录与人工新建会话会在服务端创建可追溯记录。", `<button class="btn primary" data-action="new-conversation">${icon("plus",15)}发起会话</button>`)}
      <section class="card">${empty("暂无会话", "请先在“客户与会员”创建真实客户档案，或等待前台咨询产生会话后再接待。")}</section>
    </div>`;
  }
  const customer = store.customer(current.customerId);
  if (!customer) {
    return `<div class="page">${pageHead("客户沟通", "会话与接待", "会话关联的客户档案不存在，无法继续接待。", `<button class="btn" data-action="refresh">${icon("refresh",15)}刷新</button>`)}
      <section class="card">${empty("会话关联异常", "请刷新后台；若问题持续，请在审计记录中核查该会话。")}</section>
    </div>`;
  }
  const handover = linkedHandoverForConversation(current);
  const assignee = handoverAssigneeDisplay(handover);
  const phrases = commonPhraseRecords();
  const imChannels = phaseOneImChannels();
  return `<div class="page reception-page" style="padding-bottom:20px">${pageHead("客户沟通", "会话与接待", isPresalesWorkspace() ? "这里展示已进入聊天的客户会话。售前人员可实名接管、确认后将会话交回机器人，并调用已启用的常用话术；所有操作都会留下审计记录。" : "查看实时咨询、未读消息和接待状态；选择客户后处理对应会话。", isPresalesWorkspace() ? "" : `<button class="btn" data-action="conversation-stats">${icon("chart",15)}会话质量检查</button><button class="btn primary" data-action="new-conversation">${icon("plus",15)}发起会话</button>`)}
    <section class="card conversation-layout">
      <aside class="conversation-list"><div class="conversation-filter"><strong>接待工作台</strong><div class="caption" role="status">${ui.conversationSyncError || "会话实时同步"}</div><div class="search-field" style="min-width:0;margin-top:12px">${icon("search",15)}<input id="reception-search" class="field" aria-label="搜索客户或会话" placeholder="搜索客户、渠道、会话内容" value="${escapeHtml(ui.conversationQuery)}"/></div><div class="reception-filters">${["全部","待人工","人工接待","机器人","已结束"].map(filter=>`<button class="tab-btn ${ui.conversationFilter===filter?'active':''}" data-action="conversation-filter" data-id="${filter}">${filter}<span>${store.state.conversations.filter(item=>filter==='全部'||groupOf(item)===filter).length}</span></button>`).join('')}</div></div><div class="conversation-items" data-paginated-list="conversations" data-pagination-item=".conversation-item">${['待人工','人工接待','机器人','已结束'].map(group=>{const items=conversations.filter(item=>groupOf(item)===group);return items.length?`<details class="reception-group" open><summary>${group} <span>${items.length}</span></summary>${items.map(conversation=>{const itemCustomer=store.customer(conversation.customerId);if(!itemCustomer)return '';return `<button class="conversation-item ${conversation.id===current.id?'active':''}" data-search="${escapeHtml([itemCustomer.name,conversation.channel,conversation.lastMessage].join(' ').toLowerCase())}" data-action="select-conversation" data-id="${escapeHtml(conversation.id)}">${avatar(itemCustomer,'sm')}<div style="min-width:0"><div class="row"><span class="conversation-name">${escapeHtml(itemCustomer.name)}</span></div><div class="conversation-preview">${escapeHtml(conversation.lastMessage||'暂无消息')}</div><div class="customer-meta">${escapeHtml(conversation.channel)} · ${relativeTime(conversation.updatedAt)}</div></div>${conversationReads.unread(conversation)?`<span class="unread" aria-label="${conversationReads.unread(conversation)}条未读消息">${Math.min(conversationReads.unread(conversation),99)}${conversationReads.unread(conversation)>99?"+":""}</span>`:''}</button>`;}).join('')}</details>`:'';}).join('')}<p id="reception-empty" class="caption" hidden>没有匹配的会话，请调整搜索或分组。</p></div></aside>
      <section class="chat"><header class="chat-head">${avatar(customer,"sm")}<div><strong>${customer.name}</strong><div class="customer-meta">${escapeHtml(current.channel)} · ${conversationStatusLabel(current.status)}</div></div><div class="caption" style="margin-left:6px;line-height:1.45"><strong style="color:var(--ink)">当前接待：${escapeHtml(assignee.title)}</strong><br/>${escapeHtml(assignee.detail)}</div><span class="spacer"></span><button class="btn small ghost" data-entity="conversation" data-id="${current.id}">详情</button>${acquisitionConversationControls(current, customer)}<button class="btn icon-only ghost" data-customer="${customer.id}" aria-label="客户360">${icon("users",17)}</button></header>
        <div class="chat-body">${(current.messages || []).map((message) => `<div class="message ${message.from === "customer" ? "customer" : message.from === "system" ? "system" : ""}">${message.from !== "system" ? `<div class="avatar sm" style="display:grid;place-items:center;background:${message.from === "customer" ? "#f0d4db" : "#ebe5f4"};color:${message.from === "customer" ? "var(--brand)" : "#7651a8"};font-size:10px;font-weight:800">${escapeHtml(message.from === "customer" ? customer.name.slice(0,1) : message.from === "staff" ? String(assignee.title || customer.owner).slice(0,1) : "AI")}</div>` : ""}<div><div class="message-bubble">${escapeHtml(message.text)}</div><div class="message-time">${formatDate(message.at)}</div></div></div>`).join("")}</div>
        ${acquisitionConversationComposer(current, customer)}
      </section>
      <aside class="customer-sidebar reception-tools"><div class="reception-tabs" role="tablist" aria-label="接待辅助工具">${[['phrases','常用话术'],['customer','客户资料'],['channel','渠道状态']].map(([id,label])=>`<button role="tab" aria-selected="${ui.receptionTab===id}" class="tab-btn ${ui.receptionTab===id?'active':''}" data-action="reception-tab" data-id="${id}">${label}</button>`).join('')}</div><section data-reception-panel="customer" ${ui.receptionTab==='customer'?'':'hidden'}><div class="compact-customer">${avatar(customer,"lg")}<div class="compact-customer-name">${escapeHtml(customer.name)}</div><div class="compact-customer-meta">${escapeHtml(customer.macroStage)} · ${escapeHtml(customer.microStage)}</div><button class="btn small" style="margin-top:9px" data-customer="${customer.id}">打开客户资料</button></div>
        <div class="section-title">当前接待</div><div class="responsibility-row"><div class="responsibility-icon">${icon(handover?.ai_suspended ? "users" : "bot",16)}</div><div><div class="responsibility-name">${escapeHtml(assignee.title)}</div><div class="responsibility-role">${escapeHtml(assignee.detail)}</div></div></div>
        </section><section data-reception-panel="channel" ${ui.receptionTab==='channel'?'':'hidden'}>        <div class="divider"></div><div class="section-title">IM 接入状态</div><div class="tag-list">${imChannels.map((channel) => badge(`${channel.name} · ${channelStatusLabel(channel)}`, channel.status === "misconfigured" ? "warning" : channel.status === "configured" ? "brand" : "outline")).join("")}</div><div class="caption" style="margin-top:8px">通道状态以服务端配置为准；待连接或待验收时只能登记已发生的人工沟通，不能对外发送。</div>
</section><section data-reception-panel="phrases" ${ui.receptionTab==='phrases'?'':'hidden'}><div class="row between"><strong>常用话术</strong><button class="link" data-action="open-phrase-library">管理话术</button></div><input class="field" id="reception-phrase-search" aria-label="搜索常用话术" placeholder="搜索话术标题或内容"/><div class="reception-phrases">${[...new Set(phrases.map(p=>p.category||p.group||'通用话术'))].map(group=>`<details open><summary>${escapeHtml(group)}</summary>${phrases.filter(p=>(p.category||p.group||'通用话术')===group).map(phrase=>`<article class="reception-phrase" data-phrase-search="${escapeHtml((phrase.name+' '+phrase.content).toLowerCase())}"><div class="row between"><strong>${escapeHtml(phrase.name)}</strong><button class="btn small ghost" data-action="use-common-phrase" data-id="${escapeHtml(phrase.id)}">插入</button></div><p>${escapeHtml(phrase.content)}</p></article>`).join('')}</details>`).join('')||'<p class="caption">暂无已启用话术，可到话术库维护。</p>'}</div><p id="reception-phrase-empty" class="caption" hidden>未找到匹配的话术。</p></section><section data-reception-panel="customer" ${ui.receptionTab==='customer'?'':'hidden'}>
        <div class="section-title">项目兴趣</div>${customer.interests.slice(0,2).map((item) => `<div class="interest-row"><span class="interest-name">${item.name}</span><div class="interest-track"><div class="interest-fill" style="width:${item.score}%"></div></div><strong>${item.score}</strong></div>`).join("")}
        <div class="divider"></div><div class="section-title">下一步建议</div><div class="caption" style="line-height:1.6">${customer.nextAction.title}</div><div class="guardrail" style="margin-top:9px">${icon("shield",13)}${customer.nextAction.guardrail}</div>
        <div class="divider"></div><div class="section-title">痛痒爽点</div><div class="tag-list">${customer.pains.map((item) => badge(item,"danger")).join("")}${customer.itches.map((item) => badge(item,"warning")).join("")}</div>
        ${current.status === "待人工" ? `<div class="risk-banner">${icon("alert",15)}当前会话因医疗边界转人工。接管后AI停止对外发送。</div>` : ""}
      </section></aside>
    </section>
  </div>`;
}

function journeysPage() {
  if (ui.journeyView === "editor") return journeyEditorPage();
  const metrics = managementOverviewMetrics();
  const running = store.state.journeys.filter((item) => item.status === "运行中").length;
  return `<div class="page">${pageHead("客户旅程管理", "旅程自动化", "为客户在不同阶段安排可确认、可暂停、可回顾的持续跟进流程。", `<button class="btn" data-action="journey-instances">客户旅程进度</button><button class="btn primary" data-action="new-journey">${icon("plus",15)}新建旅程</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("运行中的客户旅程", running, "当前旅程配置", "route")}${metric("在旅程内客户", String(metrics.customers.filter((item) => (item.journeys || []).some((journey) => journey.status === "运行中")).length), "当前系统内记录", "users")}${metric("暂停旅程", String(store.state.journeys.filter((item) => item.status === "暂停").length), "待人工复核后恢复", "chart")}${metric("需要人工处理", String(metrics.openTasks.filter((item) => ["AI转人工", "AI审批"].includes(item.type)).length), "已创建人工任务", "alert")}</div>
    <div class="toolbar"><select class="select"><option>全部生命周期</option><option>售前</option><option>售中</option><option>售后</option></select><select class="select"><option>全部状态</option><option>运行中</option><option>草稿</option><option>已暂停</option></select><div class="search-field">${icon("search",15)}<input class="field" placeholder="搜索旅程…"/></div><span class="spacer"></span>${badge("旅程动作均经过授权、频控和合规门禁","brand")}</div>
    <div class="journey-cards" data-paginated-list="journeys">${store.state.journeys.map((journey) => `<article class="card journey-card"><div class="row between"><div>${badge(journey.stage)} ${badge(journey.status)}${journey.draftCanvas ? ` ${badge(`待发布 ${journey.draftVersion || "新版本"}`, "brand")}` : ""}</div><button class="btn icon-only ghost" data-action="journey-more" data-id="${journey.id}">${icon("more",16)}</button></div><h3 style="margin:13px 0 4px;font-size:16px">${journey.name}</h3><div class="caption">负责人：${journey.owner} · 更新于 ${relativeTime(journey.updatedAt)}</div><div class="journey-stats"><div class="mini-stat"><div class="mini-stat-label">当前关联客户</div><div class="mini-stat-value">${journey.runtimeMembers || 0}</div></div><div class="mini-stat"><div class="mini-stat-label">运行中关系</div><div class="mini-stat-value">${journey.runtimeRunningMembers || 0}</div></div><div class="mini-stat"><div class="mini-stat-label">流程步骤</div><div class="mini-stat-value">${journey.nodes.length}</div></div></div><div class="node-flow">${journey.nodes.slice(0,5).map((node,index) => `<span class="node-dot" title="${node}">${index+1}</span>${index < Math.min(4,journey.nodes.length-1) ? `<span class="node-line"></span>` : ""}`).join("")}${journey.nodes.length > 5 ? `<span class="caption">+${journey.nodes.length-5}</span>` : ""}</div><div class="row"><button class="btn small" data-action="edit-journey" data-id="${journey.id}">编辑</button>${journey.status === "草稿" || journey.draftCanvas ? `<button class="btn small primary" data-action="publish-journey" data-id="${journey.id}">提交发布</button>` : `<button class="btn small ${journey.status === "运行中" ? "danger" : "success"}" data-action="toggle-journey" data-id="${journey.id}">${journey.status === "运行中" ? "暂停" : "恢复"}</button>`}<button class="btn small ghost" data-action="journey-review" data-id="${journey.id}">效果复盘</button></div></article>`).join("")}</div>
  </div>`;
}

const journeyNodeCatalog = {
  trigger:{ label:"开始条件", icon:"spark", description:"由客户事件、预约或阶段变化进入旅程", defaults:{ condition:"客户满足旅程进入条件", successAction:"进入下一步骤", timeoutAction:"—", wait:"", branchYes:"进入流程", branchNo:"不进入" } },
  decision:{ label:"条件判断", icon:"route", description:"按客户阶段、兴趣、授权或行为进行分流", defaults:{ condition:"客户满足分流条件", successAction:"满足后继续", timeoutAction:"不满足则进入备用路径", wait:"", branchYes:"满足条件", branchNo:"不满足" } },
  ai:{ label:"AI服务动作", icon:"bot", description:"由智能体执行已批准的说明、提醒或问卷", defaults:{ condition:"使用已发布知识且客户授权有效", successAction:"记录客户反馈并进入下一步", timeoutAction:"低置信度时转人工", wait:"", branchYes:"完成服务", branchNo:"转人工" } },
  human:{ label:"人工任务", icon:"users", description:"创建人工邀约、接管或回访事项", defaults:{ condition:"需要人工确认或客户请求人工", successAction:"人工完成后推进", timeoutAction:"超时提醒负责人", wait:"24小时", branchYes:"人工已处理", branchNo:"超时提醒" } },
  wait:{ label:"等待安排", icon:"clock", description:"等待固定时间或客户行为后再继续", defaults:{ condition:"等待窗口开始", successAction:"重新判断下一步", timeoutAction:"到期后结束或转人工", wait:"24小时", branchYes:"等待结束", branchNo:"超时" } },
  compliance:{ label:"合规检查", icon:"shield", description:"在执行前校验授权、频控与医疗边界", defaults:{ condition:"授权有效、频次合规、未命中医疗边界", successAction:"放行下一动作", timeoutAction:"拦截并创建人工任务", wait:"", branchYes:"通过检查", branchNo:"拦截" } },
  end:{ label:"目标/退出", icon:"check", description:"记录服务结果并结束当前旅程", defaults:{ condition:"达到退出或目标条件", successAction:"写入客户360", timeoutAction:"—", wait:"", branchYes:"完成", branchNo:"结束" } }
};

const journeyNodeTypeOrder = ["trigger", "decision", "ai", "human", "wait", "compliance", "end"];

function journeyNodeTypeFor(label, index, total) {
  const value = String(label || "");
  if (index === 0) return "trigger";
  if (index === total - 1) return "end";
  if (/授权|合规|医疗|异常/.test(value)) return "compliance";
  if (/判断|识别|分支|兴趣/.test(value)) return "decision";
  if (/人工|面诊|邀约|交接/.test(value)) return "human";
  if (/等待|第\d+天|时机/.test(value)) return "wait";
  return "ai";
}

function createJourneyCanvasNode(type, index = 0, total = 1, name = "") {
  const safeType = journeyNodeCatalog[type] ? type : "ai";
  const catalog = journeyNodeCatalog[safeType];
  return {
    id:`node-${Date.now().toString(36)}-${index + 1}`,
    type:safeType,
    name:name || catalog.label,
    description:catalog.description,
    ...catalog.defaults,
    order:index,
    total
  };
}

function journeyCanvasDraft(journey) {
  const stored = ui.journeyCanvasDrafts[journey.id];
  if (stored?.nodes?.length) return stored;
  const source = journey.draftCanvas || journey.canvas;
  const nodes = source?.nodes?.length
    ? source.nodes.map((node, index) => ({ ...createJourneyCanvasNode(node.type, index, source.nodes.length, node.name), ...node }))
    : journey.nodes.map((name, index, all) => createJourneyCanvasNode(journeyNodeTypeFor(name, index, all.length), index, all.length, name));
  const draft = { nodes };
  ui.journeyCanvasDrafts[journey.id] = draft;
  return draft;
}

function selectedJourneyCanvasNode(journey) {
  const draft = journeyCanvasDraft(journey);
  const selectedId = ui.journeyCanvasSelection[journey.id];
  const fallback = draft.nodes[Math.min(2, draft.nodes.length - 1)] || draft.nodes[0];
  const node = draft.nodes.find((item) => item.id === selectedId) || fallback;
  if (node) ui.journeyCanvasSelection[journey.id] = node.id;
  return node;
}

function journeyCanvasPage(journeyId = "") {
  const journey = store.state.journeys.find((item) => item.id === journeyId) || store.state.journeys[0];
  if (!journey) return empty("没有可编辑的旅程", "请先创建一条旅程后再进入画布");
  const draft = journeyCanvasDraft(journey);
  const selected = selectedJourneyCanvasNode(journey);
  const zoom = Math.min(1.2, Math.max(.8, Number(ui.journeyCanvasZoom[journey.id]) || 1));
  const hasDraft = Boolean(journey.draftCanvas);
  const draftLabel = journey.status === "草稿" ? "草稿编辑中" : hasDraft ? `待发布 ${journey.draftVersion || "草稿"}` : "基于当前版本编辑";
  const nodeCard = (node, index) => {
    const catalog = journeyNodeCatalog[node.type] || journeyNodeCatalog.ai;
    const isSelected = node.id === selected?.id;
    const isDecision = node.type === "decision" || node.type === "compliance";
    return `<div class="journey-canvas-step">
      <button class="journey-canvas-node ${isSelected ? "selected" : ""} ${node.type}" data-action="select-journey-node" data-id="${escapeHtml(node.id)}" aria-pressed="${isSelected}">
        <span class="journey-node-icon">${icon(catalog.icon,16)}</span><span class="journey-node-copy"><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(catalog.label)} · 步骤 ${index + 1}</small></span>${isDecision ? `<span class="journey-node-split">分支</span>` : ""}
      </button>
      ${isDecision ? `<div class="journey-branch-row"><span>✓ ${escapeHtml(node.branchYes || "继续下一步")}</span><span>× ${escapeHtml(node.branchNo || "转人工或结束")}</span></div>` : ""}
      ${index < draft.nodes.length - 1 ? `<div class="journey-canvas-connector" aria-hidden="true"><span></span>${icon("chevron",13)}</div>` : ""}
    </div>`;
  };
  const field = (label, name, value, options = {}) => formField(label, name, value || "", options);
  return `<div class="page">${pageHead("自动化运营", journey.name, `当前版本 ${journey.version} · ${journey.stage} · 画布修改先保存为待发布版本，不会覆盖正在服务客户的流程。`, `<a class="btn" href="#/journeys">返回列表</a><button class="btn" data-action="test-journey" data-id="${journey.id}">${icon("check",15)}检查画布</button><button class="btn primary" data-action="save-journey" data-id="${journey.id}">${icon("check",15)}保存新版本</button>${hasDraft ? `<button class="btn success" data-action="publish-journey" data-id="${journey.id}">${icon("check",15)}提交发布</button>` : ""}`)}
    <div class="object-tabs"><button class="active">流程编排</button><a href="#/journeys/instances">客户旅程进度</a><a href="#/journeys/review">效果复盘</a><span class="spacer"></span>${badge(draftLabel, journey.status === "草稿" ? "warning" : hasDraft ? "brand" : "outline")}</div>
    <section class="card journey-canvas-editor">
      <aside class="node-palette"><div class="card-title">步骤库</div><div class="card-subtitle">点击后会插入到当前选中节点之后</div><div class="node-palette-list">${journeyNodeTypeOrder.filter((type) => type !== "end").map((type) => { const item = journeyNodeCatalog[type]; return `<button class="node-tool" data-action="add-node" data-id="${type}"><span class="responsibility-icon">${icon(item.icon,14)}</span><span><strong>${item.label}</strong><small>${item.description}</small></span></button>`; }).join("")}</div><div class="canvas-palette-note">${icon("shield",14)}所有自动动作在执行前仍需经过授权、频控和医疗安全校验。</div></aside>
      <div class="journey-canvas-shell"><header class="journey-canvas-toolbar"><div><strong>旅程画布</strong><span>${draft.nodes.length} 个步骤 · ${draft.nodes.filter((node) => ["decision", "compliance"].includes(node.type)).length} 个分支点</span></div><div class="row"><button class="btn icon-only ghost" data-action="canvas-zoom" data-id="-0.1" aria-label="缩小画布">−</button><span class="canvas-zoom-value">${Math.round(zoom * 100)}%</span><button class="btn icon-only ghost" data-action="canvas-zoom" data-id="0.1" aria-label="放大画布">＋</button></div></header><div class="canvas journey-canvas" style="--journey-zoom:${zoom}"><div class="journey-canvas-flow">${draft.nodes.map(nodeCard).join("")}</div></div></div>
      <aside class="properties journey-node-properties">${selected ? `<form id="journey-node-form" data-journey-id="${escapeHtml(journey.id)}" data-node-id="${escapeHtml(selected.id)}"><div class="row between"><div><div class="card-title">节点设置</div><div class="card-subtitle">${escapeHtml(selected.name)}</div></div>${badge(journeyNodeCatalog[selected.type]?.label || "服务动作", selected.type === "compliance" ? "danger" : "ai")}</div><div class="journey-node-form-fields">${field("节点名称", "name", selected.name, { required:true })}${field("节点类型", "type", selected.type, { type:"select", items:journeyNodeTypeOrder.map((type) => ({ value:type, label:journeyNodeCatalog[type].label })) })}${field("执行说明", "description", selected.description, { type:"textarea" })}${field("进入条件", "condition", selected.condition, { type:"textarea" })}${field("成功后动作", "successAction", selected.successAction, { type:"textarea" })}${field("超时/未满足动作", "timeoutAction", selected.timeoutAction, { type:"textarea" })}${["human", "wait"].includes(selected.type) ? field("等待时长", "wait", selected.wait) : ""}${["decision", "compliance"].includes(selected.type) ? `${field("满足条件路径", "branchYes", selected.branchYes)}${field("不满足条件路径", "branchNo", selected.branchNo)}` : ""}</div><div class="journey-node-actions"><button class="btn primary" type="submit">暂存节点修改</button><button class="btn danger ghost" type="button" data-action="delete-journey-node" data-id="${escapeHtml(selected.id)}" ${["trigger", "end"].includes(selected.type) ? "disabled" : ""}>删除节点</button></div><div class="risk-banner">${icon("shield",14)}画布只保存流程配置。触达、预约和客户数据写入仍需在运行时重新校验权限与合规规则。</div></form>` : empty("请选择一个流程节点", "从画布中选择节点后，可在这里维护条件和后续动作")}</aside>
    </section>
  </div>`;
}

function activeJourneyCanvas(journeyId = "") {
  const route = routeInfo();
  const id = journeyId || (route.route === "journey" ? route.id : "") || ui.journeyId;
  return store.state.journeys.find((item) => item.id === id) || store.state.journeys[0];
}

function selectJourneyCanvasNode(nodeId, journeyId = "") {
  const journey = activeJourneyCanvas(journeyId);
  if (!journey || !journeyCanvasDraft(journey).nodes.some((node) => node.id === nodeId)) return;
  ui.journeyCanvasSelection[journey.id] = nodeId;
  render(true);
}

function addJourneyCanvasNode(type, journeyId = "") {
  const journey = activeJourneyCanvas(journeyId);
  if (!journey || !journeyNodeCatalog[type]) return;
  const draft = journeyCanvasDraft(journey);
  const selected = selectedJourneyCanvasNode(journey);
  const selectedIndex = Math.max(0, draft.nodes.findIndex((node) => node.id === selected?.id));
  const insertionIndex = Math.min(Math.max(1, selectedIndex + 1), Math.max(1, draft.nodes.length - 1));
  const node = createJourneyCanvasNode(type, insertionIndex, draft.nodes.length + 1);
  draft.nodes.splice(insertionIndex, 0, node);
  ui.journeyCanvasSelection[journey.id] = node.id;
  render(true);
  toast(`已插入“${journeyNodeCatalog[type].label}”节点，请在右侧完善执行条件`, "success");
}

function updateJourneyCanvasNode(form) {
  const journey = activeJourneyCanvas(form.dataset.journeyId);
  const draft = journey ? journeyCanvasDraft(journey) : null;
  const node = draft?.nodes.find((item) => item.id === form.dataset.nodeId);
  if (!journey || !node) return toast("节点已不存在，请刷新画布后重试", "warning");
  const data = Object.fromEntries(new FormData(form));
  const nextType = journeyNodeCatalog[data.type] ? data.type : node.type;
  const defaults = journeyNodeCatalog[nextType].defaults;
  Object.assign(node, {
    type:nextType,
    name:String(data.name || "").trim().slice(0, 80),
    description:String(data.description || "").trim().slice(0, 180),
    condition:String(data.condition || "").trim().slice(0, 300),
    successAction:String(data.successAction || "").trim().slice(0, 180),
    timeoutAction:String(data.timeoutAction || "").trim().slice(0, 180),
    wait:String(data.wait || defaults.wait || "").trim().slice(0, 80),
    branchYes:String(data.branchYes || defaults.branchYes || "继续下一步").trim().slice(0, 80),
    branchNo:String(data.branchNo || defaults.branchNo || "结束或转人工").trim().slice(0, 80)
  });
  if (!node.name) return toast("请填写节点名称", "warning");
  ui.journeyCanvasSelection[journey.id] = node.id;
  render(true);
  toast("节点修改已暂存，保存新版本后才会进入发布流程", "success");
}

function deleteJourneyCanvasNode(nodeId, journeyId = "") {
  const journey = activeJourneyCanvas(journeyId);
  const draft = journey ? journeyCanvasDraft(journey) : null;
  const index = draft?.nodes.findIndex((node) => node.id === nodeId) ?? -1;
  if (!journey || index < 0) return;
  const node = draft.nodes[index];
  if (draft.nodes.length <= 2 || ["trigger", "end"].includes(node.type)) return toast("开始条件和结束节点必须保留", "warning");
  draft.nodes.splice(index, 1);
  ui.journeyCanvasSelection[journey.id] = draft.nodes[Math.max(0, index - 1)]?.id || "";
  render(true);
  toast("节点已从当前草稿移除", "success");
}

function saveJourneyCanvas(journeyId = "") {
  const journey = activeJourneyCanvas(journeyId);
  if (!journey) return;
  const journeyStatus = journey.status;
  const result = store.saveJourneyCanvas(journey.id, journeyCanvasDraft(journey));
  if (!result) return toast("画布至少需要保留开始条件和结束节点", "warning");
  render(true);
  toast(journeyStatus === "草稿" ? "旅程草稿已保存" : `已保存为 ${result.draftVersion}，当前运行版本未被覆盖`, "success");
}

function validateJourneyCanvas(journeyId = "") {
  const journey = activeJourneyCanvas(journeyId);
  if (!journey) return;
  const nodes = journeyCanvasDraft(journey).nodes;
  const checks = [
    { name:"开始条件", pass:nodes[0]?.type === "trigger", detail:"第一步必须是明确的客户进入条件" },
    { name:"结束节点", pass:nodes[nodes.length - 1]?.type === "end", detail:"最后一步必须记录退出或目标达成" },
    { name:"合规门禁", pass:nodes.some((node) => node.type === "compliance"), detail:"自动动作前需存在授权、频控或医疗边界检查" },
    { name:"节点信息", pass:nodes.every((node) => node.name && node.condition && node.successAction), detail:"每个节点都需配置名称、进入条件和成功动作" },
    { name:"人工兜底", pass:nodes.some((node) => node.type === "human") || nodes.some((node) => /人工/.test(node.timeoutAction || "")), detail:"异常、低置信度或超时应能转入人工处理" }
  ];
  const passed = checks.filter((check) => check.pass).length;
  openModal({
    title:"画布配置检查",
    desc:`${journey.name} · ${passed}/${checks.length} 项通过。本检查只验证本地配置完整性，不会触发客户动作。`,
    body:`<div class="stack">${checks.map((check) => `<div class="journey-check-row"><span class="responsibility-icon ${check.pass ? "ok" : "warn"}">${icon(check.pass ? "check" : "alert",14)}</span><div><strong>${check.name}</strong><p>${check.pass ? "已配置" : escapeHtml(check.detail)}</p></div>${badge(check.pass ? "通过" : "待补充", check.pass ? "success" : "warning")}</div>`).join("")}${passed === checks.length ? `<div class="guardrail">${icon("shield",14)}可提交审批或发布流程；正式发布前仍需由服务端执行测试客户回放、规则版本校验和双人审批。</div>` : `<div class="risk-banner">${icon("alert",14)}请补齐未通过项后再保存新版本。当前检查不会把配置标记为可正式发布。</div>`}</div>`,
    footer:`<button class="btn primary" data-action="modal-close">关闭</button>`
  });
}

function journeyEditorPage() {
  const journey = store.state.journeys.find((item) => item.id === ui.journeyId) || store.state.journeys[0];
  return journeyCanvasPage(journey?.id);
  return `<div class="page">${pageHead("客户旅程编辑", journey.name, `${journey.stage} · 每次调整都会保存记录，已经运行的流程不会被直接覆盖。`, `<button class="btn" data-action="back-journeys">返回列表</button><button class="btn" data-action="test-journey">试运行</button><button class="btn primary" data-action="save-journey">保存调整</button>`)}
    <section class="card grid journey-editor"><aside class="node-palette"><div class="card-title">可用步骤</div><div class="card-subtitle">点击加入当前流程</div><div class="stack" style="margin-top:14px">${[["开始条件","新咨询、预约、支付"],["条件判断","阶段、兴趣、授权、行为"],["AI协助","解释、提醒、问卷"],["人工任务","邀约、接管、回访"],["等待","固定时间或事件等待"],["合规检查","授权、联系频次、医疗边界"]].map(([title,desc]) => `<button class="btn" style="height:auto;padding:10px;justify-content:flex-start;text-align:left" data-action="add-node"><span class="responsibility-icon" style="width:27px;height:27px">${icon("plus",13)}</span><span><strong style="display:block;font-size:11px">${title}</strong><span class="caption">${desc}</span></span></button>`).join("")}</div></aside><div class="canvas">${journey.nodes.map((node,index) => `<div class="flow-node ${index === 2 ? "active" : ""}"><div class="row"><span class="responsibility-icon" style="width:28px;height:28px">${icon(index === 0 ? "spark" : index === journey.nodes.length-1 ? "check" : "route",14)}</span><div><div class="flow-node-title">${node}</div><div class="flow-node-type">步骤 ${index+1} · ${index === 0 ? "开始条件" : index === journey.nodes.length-1 ? "完成/退出" : "跟进动作"}</div></div></div></div>`).join("")}</div><aside class="properties"><div class="card-title">步骤设置</div><div class="card-subtitle">价格顾虑分支</div><div class="form-grid" style="grid-template-columns:1fr;margin-top:16px">${formField("步骤名称","node-name","价格顾虑分支")}${formField("判断条件","condition","最近会话包含价格顾虑，且营销授权有效",{type:"textarea"})}${formField("后续动作","success","创建人工邀约任务")}${formField("等待时间","timeout","24小时")}</div><div class="risk-banner">${icon("shield",14)}执行前会重新检查客户授权和联系频次。</div></aside></section>
  </div>`;
}

function agentExecutionLabel(level = "") {
  if (String(level).startsWith("L1")) return "人工审核后执行";
  if (String(level).startsWith("L2")) return "授权范围内自动执行";
  if (String(level).startsWith("L4")) return "系统强制启用";
  return "按岗位权限执行";
}

function agentKnowledgeLabel(value = "") {
  return String(value).replace(/\s+v[\d.]+$/i, "");
}

const isMandatoryAgent = (agent = {}) => Boolean(
  agent.systemManaged
  || agent.mandatory
  || agent.levelCode === "L4_MANDATORY"
  || agent.id === "A-06"
);

const agentFieldList = (value) => String(value || "")
  .split(/[、,，；;\n]/)
  .map((item) => item.trim())
  .filter(Boolean);

const agentEvaluationCopy = (agent = {}) => {
  const gate = agent.evaluationGate || {};
  const rawScore = gate.lastScore ?? agent.lastEval;
  const hasScore = rawScore !== null && rawScore !== undefined && rawScore !== "" && Number.isFinite(Number(rawScore));
  const score = hasScore ? `${Number(rawScore)}分` : "待评测";
  const status = gate.status || (score === "待评测" ? "待评测" : "待核验");
  return `${status} · ${score}`;
};

function agentsPage() {
  const metrics = managementOverviewMetrics();
  const agents = store.state.agents || [];
  const activeCount = agents.filter((item) => item.status === "运行中").length;
  const pilotCount = agents.filter((item) => item.status === "试运行" || item.status === "灰度中").length;
  const draftCount = agents.filter((item) => item.status === "草稿").length;
  return `<div class="page">${pageHead("智能体管理", "AI员工", "管理员维护智能体的岗位档案、能力边界、知识范围、负责人和评测门槛。页面保存的是受控运营配置；运行时发布仍须通过部署配置、权限审批和回归评测。", `<button class="btn" data-action="agent-api">${icon("database",15)}接口管理</button><button class="btn" data-action="agent-evals">能力与合规检查</button><button class="btn primary" data-action="new-agent">${icon("plus",15)}新增智能体</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("运行中", String(activeCount), "已满足当前岗位准入", "bot")}${metric("试运行", String(pilotCount), "需持续回归与人工观察", "spark")}${metric("草稿待配置", String(draftCount), "未满足启用条件不会运行", "clock")}${metric("人工接管会话", String(metrics.conversations.filter((item) => ["待人工", "人工处理中"].includes(item.status)).length), "涉及医疗边界优先", "users")}</div>
    <div class="agent-cards" data-paginated-list="agents">${agents.map((agent) => {
      const mandatory = isMandatoryAgent(agent);
      const evaluation = agentEvaluationCopy(agent);
      const statusTone = agent.status === "运行中" ? "success" : agent.status === "试运行" || agent.status === "灰度中" ? "warning" : agent.status === "已停用" ? "danger" : "outline";
      return `<article class="card agent-card"><div class="row"><div class="agent-icon">${icon(mandatory ? "shield" : "bot",21)}</div><div><h3 style="margin:0 0 4px;font-size:15px">${escapeHtml(agent.name)}</h3><div class="caption">${escapeHtml(agent.role)}</div></div><span class="spacer"></span>${badge(agent.status === "灰度中" ? "试运行" : agent.status, statusTone)}</div><div class="row wrap" style="margin-top:12px">${badge(agentExecutionLabel(agent.levelCode || agent.level),"brand")}${badge(evaluation, (agent.evaluationGate || {}).status === "通过" ? "success" : "outline")}${mandatory ? badge("系统强制守门","danger") : ""}</div><div class="agent-kpis"><div class="agent-kpi"><strong>${agent.runtimeActiveCustomers || 0}</strong><span>当前服务客户</span></div><div class="agent-kpi"><strong>${agent.runtimeConversationCount || 0}</strong><span>关联会话</span></div><div class="agent-kpi"><strong>${agent.runtimeOpenTaskCount || 0}</strong><span>未完成待办</span></div><div class="agent-kpi"><strong>${agent.status === "运行中" ? "已启用" : escapeHtml(agent.status || "草稿")}</strong><span>当前运行状态</span></div></div><div class="caption">可处理事项</div><div class="skill-list">${(agent.skills || []).map((skill) => badge(skill,"outline")).join("") || badge("待配置","outline")}</div><div class="caption" style="margin-top:11px">不可执行</div><div class="skill-list">${(agent.forbidden || []).map((item) => badge(item,"danger")).join("") || badge("待配置","outline")}</div><div class="divider"></div><div class="row wrap"><button class="btn small" data-action="agent-detail" data-id="${escapeHtml(agent.id)}">查看详情</button>${mandatory ? `<span class="caption">系统守门员不可停用或删除</span>` : `<button class="btn small" data-action="edit-agent" data-id="${escapeHtml(agent.id)}">${icon("edit",13)}编辑配置</button><button class="btn small ${agent.status === "已停用" ? "success" : "danger"}" data-action="toggle-agent" data-id="${escapeHtml(agent.id)}">${agent.status === "已停用" ? "启用" : "停用"}</button><button class="btn small danger" data-action="delete-agent" data-id="${escapeHtml(agent.id)}">删除</button>`}<span class="spacer"></span><span class="caption">可用知识：${escapeHtml(agentKnowledgeLabel(agent.knowledge))}</span></div></article>`;
    }).join("") || empty("尚未登记智能体", "请先创建一份受控岗位档案；未满足评测与知识范围要求的记录将保持草稿")}</div>
  </div>`;
}

function physiciansPage() {
  const query = ui.physicianQuery.trim().toLowerCase();
  const specialties = [...new Set(store.state.physicians.flatMap((physician) => physician.specialties))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const physicians = store.state.physicians.filter((physician) => {
    const haystack = [physician.name, physician.title, physician.department, physician.branch, physician.education, physician.schedule, ...physician.specialties, ...physician.signatureProjects].join(" ").toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesStatus = ui.physicianStatus === "全部状态" || physician.status === ui.physicianStatus;
    const matchesSpecialty = ui.physicianSpecialty === "全部领域" || physician.specialties.includes(ui.physicianSpecialty);
    return matchesQuery && matchesStatus && matchesSpecialty;
  });
  const imported = store.state.physicians.filter((physician) => physician.importSource === "华美智能体知识库_v1").length;
  const pendingVerification = store.state.physicians.filter((physician) => physician.status === "资料待审核").length;
  const senior = store.state.physicians.filter((physician) => ["主任医师", "副主任医师"].includes(physician.title)).length;
  const statusTone = (status) => ["出诊中", "手术日"].includes(status) ? "success" : status === "进修中" ? "warning" : "outline";
  return `<div class="page">${pageHead("医师团队", "医师管理", "统一维护医师基本资料、执业信息、排班状态、擅长领域与代表项目。", `<button class="btn primary" data-action="new-physician">${icon("plus",15)}新增医师</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("医师资料", store.state.physicians.length, "院内医师目录", "medical")}${metric("知识库已导入", imported, "来自华美 v1 原始资料", "database")}${metric("待资质/排班核验", pendingVerification, "暂不用于推荐或预约", "shield")}${metric("专业领域", specialties.length, "按原始资料初步归类", "spark")}</div>
    <section class="card physician-directory"><div class="card-head physician-toolbar"><div><div class="card-title">医师团队</div><div class="card-subtitle">点击医师查看完整档案，或直接编辑团队信息</div></div><div class="knowledge-filters"><select class="select" id="physician-status">${["全部状态","出诊中","手术日","进修中","休诊"].map((status) => `<option ${ui.physicianStatus===status?"selected":""}>${status}</option>`).join("")}</select><select class="select" id="physician-specialty"><option ${ui.physicianSpecialty==="全部领域"?"selected":""}>全部领域</option>${specialties.map((specialty) => `<option ${ui.physicianSpecialty===specialty?"selected":""}>${escapeHtml(specialty)}</option>`).join("")}</select><div class="search-field">${icon("search",15)}<input id="physician-search" class="field" value="${escapeHtml(ui.physicianQuery)}" placeholder="搜索姓名、科室、领域或项目…" /></div>${badge(`当前 ${physicians.length} 位`)}</div></div>
      <div class="physician-grid" data-paginated-list="physicians">${physicians.length ? physicians.map((physician) => `<article class="physician-card"><div class="physician-card-top">${physicianAvatar(physician, "lg")}<div class="physician-card-identity"><div class="row wrap">${badge(physician.status,statusTone(physician.status))}${badge(physician.title,"brand")}</div><h3>${escapeHtml(physician.name)}</h3><p>${escapeHtml(physician.department)} · ${physician.years ? `从业 ${physician.years} 年` : "从业年限待核验"}</p><span>${escapeHtml(physician.branch)}</span></div></div><div class="physician-card-section"><div class="caption">擅长领域</div><div class="skill-list">${physician.specialties.map((specialty) => badge(specialty,"outline")).join("")}</div></div><div class="physician-card-section"><div class="caption">代表项目</div><p>${physician.signatureProjects.map(escapeHtml).join(" · ") || "待维护"}</p></div><div class="physician-card-stats"><div><strong>${physician.importSource ? `${physician.sourceRecordCount || 0}份` : physician.consultationCount || 0}</strong><span>${physician.importSource ? "原始资料" : "院内咨询量"}</span></div><div><strong>${physician.importSource ? "待核验" : physician.satisfaction ? `${physician.satisfaction}%` : "—"}</strong><span>${physician.importSource ? "资质与排班" : "满意度"}</span></div><div><strong>${escapeHtml(physician.schedule || "待排班")}</strong><span>常规排班</span></div></div><div class="physician-card-footer">${physician.importSource ? badge("知识库导入","brand") : ""}<span class="spacer"></span><button class="btn small ghost" data-action="edit-physician" data-id="${physician.id}">${icon("edit",13)}编辑</button><button class="btn small" data-entity="physician" data-id="${physician.id}">查看档案 ${icon("arrow",13)}</button></div></article>`).join("") : empty("没有匹配的医师", "请调整姓名、状态或擅长领域筛选")}</div>
    </section>
  </div>`;
}

const avatarStudioHash = (physicianId = "") => `#/physicians/avatar${physicianId ? `/${encodeURIComponent(physicianId)}` : ""}`;

const avatarReferencePhysicianIds = new Set(["DR-001", "DR-002", "DR-003", "DR-004", "DR-005", "DR-006"]);
const avatarVoicePresets = Object.freeze([
  { id:"Chinese (Mandarin)_Wise_Women", name:"自然知性女声", gender:"女", disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_Gentleman", name:"自然温润男声", gender:"男", disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_News_Anchor", name:"专业播报女声", gender:"女", category:"经典音色", disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_Reliable_Executive", name:"沉稳专业男声", gender:"男", category:"经典音色", disclosure:"系统合成音色，非医师本人原声" }
]);
const avatarDefaultVoiceIds = Object.freeze({
  女:"Chinese (Mandarin)_Wise_Women",
  男:"Chinese (Mandarin)_Gentleman"
});

function physicianAvatarReferenceId(physicianOrId) {
  const id = String(typeof physicianOrId === "string" ? physicianOrId : physicianOrId?.id || "").trim();
  return avatarReferencePhysicianIds.has(id) ? id : "";
}

const physicianAvatarReferenceFileId = (physicianOrId) => {
  const id = physicianAvatarReferenceId(physicianOrId);
  return id ? `FILE-${id}-PORTRAIT` : "";
};

function physicianReferenceImage(physician, size = "") {
  const id = physicianAvatarReferenceId(physician);
  const name = String(physician?.name || "医师");
  if (!id) return `<span class="physician-avatar avatar-reference-missing ${escapeHtml(size)}" role="img" aria-label="${escapeHtml(`${name}尚未配置生成参考形象`)}">${escapeHtml(name.slice(0,1) || "医")}</span>`;
  const source = `/assets/physicians/references/${encodeURIComponent(id)}.png`;
  return `<img class="physician-avatar avatar-reference-image ${escapeHtml(size)}" src="${escapeHtml(source)}" alt="${escapeHtml(`${name}本次生成使用的参考形象`)}" data-reference-file-id="${escapeHtml(physicianAvatarReferenceFileId(id))}" />`;
}

const avatarDefaultVoiceId = (gender) => avatarDefaultVoiceIds[gender] || avatarDefaultVoiceIds.男;

function avatarVoiceOptions(runtimeVoices, draftVoiceId = "") {
  const runtimeLoaded = Array.isArray(runtimeVoices) && runtimeVoices.length > 0;
  const source = runtimeLoaded ? [...runtimeVoices, ...avatarVoicePresets] : avatarVoicePresets;
  const options = [];
  const seen = new Set();
  source.forEach((voice) => {
    const id = String(voice?.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const preset = avatarVoicePresets.find((item) => item.id === id);
    options.push({
      ...voice,
      id,
      name:preset?.name || voice.name || "系统合成声音",
      compatibilityLabel:preset?.category || ""
    });
  });
  if (!runtimeLoaded && draftVoiceId && !seen.has(draftVoiceId)) {
    options.push({ id:draftVoiceId, name:"原有音色", compatibilityLabel:"兼容历史草稿", disclosure:"系统合成音色，非医师本人原声" });
  }
  return options;
}

const createAvatarDraft = (physician) => ({
  title:`${physician.name}医师项目科普口播`,
  script:`大家好，我是${physician.name}。今天为大家介绍常见医美项目的一般流程，具体方案需到院后由专业医师结合实际情况评估。`,
  voiceId:avatarDefaultVoiceId(physician.gender),
  resolution:"768P", duration:12, ratio:"3:4"
});

function avatarDraftFor(physician) {
  if (!ui.avatarDrafts[physician.id]) ui.avatarDrafts[physician.id] = createAvatarDraft(physician);
  return ui.avatarDrafts[physician.id];
}

function routeAvatarPhysicianId() {
  const { route, id, resourceId } = routeInfo();
  return route === "physicians" && id === "avatar" ? resourceId || "" : "";
}

function routeAvatarPhysician() {
  const physicianId = routeAvatarPhysicianId();
  return physicianId ? store.physician(physicianId) : null;
}

function syncAvatarStudioScope() {
  const physicianId = routeAvatarPhysicianId();
  if (ui.avatarJobsPhysicianId === physicianId) return;
  clearTimeout(ui.avatarPollTimer);
  ui.avatarPollTimer = null;
  ui.avatarRequestToken += 1;
  ui.avatarScopeEpoch += 1;
  ui.avatarJobsPhysicianId = physicianId;
  ui.avatarJobs = [];
  ui.avatarHydratedAt = 0;
  ui.avatarLoadError = "";
  ui.avatarLoading = false;
  ui.avatarLoadingPhysicianId = "";
  ui.avatarPollingPhysicianId = "";
  ui.avatarPollingRequestToken = 0;
  const physician = physicianId ? store.physician(physicianId) : null;
  if (physician) avatarDraftFor(physician);
}

function avatarScopeMatches(physicianId, scopeEpoch) {
  return Boolean(physicianId && routeAvatarPhysician()?.id === physicianId && ui.avatarJobsPhysicianId === physicianId && (scopeEpoch === undefined || ui.avatarScopeEpoch === scopeEpoch));
}

function invalidateAvatarHydration() {
  ui.avatarRequestToken += 1;
  ui.avatarLoading = false;
  ui.avatarLoadingPhysicianId = "";
}

function beginAvatarMutation(physicianId) {
  invalidateAvatarHydration();
  ui.avatarMutationCounts[physicianId] = (ui.avatarMutationCounts[physicianId] || 0) + 1;
  patchAvatarComposerBusyDom(physicianId);
}

function endAvatarMutation(physicianId) {
  ui.avatarMutationCounts[physicianId] = Math.max(0, (ui.avatarMutationCounts[physicianId] || 1) - 1);
  if (!ui.avatarMutationCounts[physicianId]) delete ui.avatarMutationCounts[physicianId];
}

function finishAvatarMutation(physicianId, scopeEpoch) {
  endAvatarMutation(physicianId);
  if (!avatarScopeMatches(physicianId, scopeEpoch)) return;
  patchAvatarComposerBusyDom(physicianId);
  scheduleAvatarUiPoll();
}

const avatarStatusMeta = {
  queued:["排队中","warning"], processing:["生成中","info"], completed:["已完成","success"], failed:["失败","danger"], cancelled:["已取消","outline"]
};

const avatarPhaseLabels = {
  waiting_worker:"等待生成", synthesizing_audio:"正在准备播报声音", submitting_h3_v2:"正在提交素材",
  provider_queued:"排队中", provider_running:"视频生成中", archiving_media:"正在保存作品",
  work_created:"已完成", simulation_processing:"正在生成演示作品", failed:"生成失败",
  cancelled_by_user:"用户已取消", provider_cancelled:"已取消"
};

const avatarTerminalStatuses = new Set(["completed", "failed", "cancelled"]);

function avatarMediaRatio(value) {
  const match = String(value || "").match(/^(21|16|9|4|3|1):(21|16|9|4|3|1)$/);
  if (!match) return { value:"16 / 9", portrait:false };
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { value:`${width} / ${height}`, portrait:height > width };
}

const avatarRatioLabel = (value) => value === "adaptive" ? "自动适配" : value;

function syncAvatarVideoRatio(video) {
  const media = video.closest(".avatar-job-media, .avatar-player-stage");
  if (!media || !video.videoWidth || !video.videoHeight) return;
  media.style.setProperty("--avatar-media-ratio", `${video.videoWidth} / ${video.videoHeight}`);
  media.classList.toggle("is-portrait", video.videoHeight > video.videoWidth);
}

function formatAvatarBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function formatAvatarClockDuration(value) {
  const seconds = Math.max(0, Math.round(Number.parseFloat(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}

function avatarDurationValue(...values) {
  for (const value of values) {
    const duration = Number(value);
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  return null;
}

function avatarDurationPresentation(job) {
  const metadata = job?.work?.metadata || {};
  const actual = avatarDurationValue(metadata.providerDuration, job?.providerDuration)
    || (job?.status === "completed" ? avatarDurationValue(metadata.duration, job?.duration) : null);
  const requested = avatarDurationValue(job?.requestedDuration, metadata.requestedDuration, actual ? null : job?.duration);
  const changed = actual !== null && requested !== null && Math.abs(actual - requested) > 0.01;
  return {
    actual,
    requested,
    value:actual ?? requested,
    detailLabel:actual !== null ? `${actual} 秒${changed ? `（原预计 ${requested} 秒）` : ""}` : requested !== null ? `预计 ${requested} 秒` : "—"
  };
}

const avatarIdentityReviewStatus = (job) => job?.identityReviewStatus || job?.work?.identityReviewStatus || "";

function avatarDetailRows(rows) {
  return `<dl class="avatar-detail-list">${rows.map(([label,value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`).join("")}</dl>`;
}

function avatarScopeError(message = "这条任务不在当前医师的作品列表中，请刷新后重试。") {
  return Object.assign(new Error(message), { code:"AVATAR_SCOPE_MISMATCH" });
}

function avatarBusinessError(error, fallback = "操作未完成，请稍后重试。") {
  const detail = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  if (/consent|授权/.test(detail)) return "请确认肖像与AI生成授权后再提交。";
  if (/quota|balance|limit|额度|余额/.test(detail)) return "当前生成额度不足，请联系管理员。";
  if (/auth|permission|forbidden|unauthorized|whitelist|白名单|权限/.test(detail)) return "当前账号暂无生成权限，请联系管理员。";
  if (/reference|image|file|mime|size|素材|图片/.test(detail)) return "参考图片无法使用，请重新上传符合要求的图片。";
  if (/script|title|duration|ratio|resolution|参数|口播|标题|时长|比例|清晰度/.test(detail)) return "请检查标题、口播内容和视频参数后重试。";
  if (/timeout|network|provider|unavailable|service|fetch|连接|超时|服务/.test(detail)) return "视频生成服务暂时繁忙，请稍后重试。";
  if (/cancel|取消/.test(detail)) return "任务已取消。";
  return fallback;
}

function mergeAvatarJobSnapshot(currentJob, incomingJob) {
  if (!currentJob) return incomingJob;
  if (!incomingJob) return currentJob;
  const currentTerminal = avatarTerminalStatuses.has(currentJob.status);
  const incomingTerminal = avatarTerminalStatuses.has(incomingJob.status);
  if (currentTerminal && (!incomingTerminal || incomingJob.status !== currentJob.status)) return currentJob;
  const currentUpdatedAt = Date.parse(currentJob.updatedAt || "") || 0;
  const incomingUpdatedAt = Date.parse(incomingJob.updatedAt || "") || 0;
  if (currentUpdatedAt && incomingUpdatedAt && incomingUpdatedAt < currentUpdatedAt) return currentJob;
  if (currentJob.status === incomingJob.status && Number(incomingJob.progress || 0) < Number(currentJob.progress || 0) && incomingUpdatedAt <= currentUpdatedAt) return currentJob;
  return incomingJob;
}

function updateAvatarJobSnapshot(job, physicianId = routeAvatarPhysician()?.id) {
  if (!physicianId || !avatarScopeMatches(physicianId) || job?.physicianId !== physicianId) throw avatarScopeError();
  const index = ui.avatarJobs.findIndex((item) => item.generationJobId === job.generationJobId);
  const mergedJob = index < 0 ? job : mergeAvatarJobSnapshot(ui.avatarJobs[index], job);
  if (index < 0) ui.avatarJobs.unshift(mergedJob);
  else ui.avatarJobs[index] = mergedJob;
  ui.avatarHydratedAt = Date.now();
  return mergedJob;
}

async function fetchAvatarJob(generationJobId) {
  const physicianId = routeAvatarPhysician()?.id;
  if (!physicianId) throw avatarScopeError("请先选择医师，再查看对应的任务。 ");
  const response = await fetch(`/api/local/physician-avatar/jobs/${encodeURIComponent(generationJobId)}?physician_id=${encodeURIComponent(physicianId)}`, { headers:avatarApiHeaders, cache:"no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(avatarBusinessError(body.error, "暂时无法读取这条任务，请稍后重试。"));
  updateAvatarJobSnapshot(body.data, physicianId);
  return body.data;
}

function showAvatarJobDetail(job) {
  const work = job.work;
  const metadata = work?.metadata || {};
  const durationInfo = avatarDurationPresentation(job);
  const identityNeedsReview = avatarIdentityReviewStatus(job) === "needs_review";
  const [statusLabel, tone] = avatarStatusMeta[job.status] || ["状态更新中","outline"];
  const active = ["queued","processing"].includes(job.status);
  const ratio = avatarMediaRatio(metadata.ratio || job.ratio);
  const mediaTitleId = `avatar-detail-video-${escapeHtml(job.generationJobId)}`;
  const media = work?.videoUrl
    ? `<div class="avatar-player-stage avatar-detail-player ${ratio.portrait ? "is-portrait" : ""}" style="--avatar-media-ratio:${ratio.value}"><video class="avatar-player-video" controls playsinline preload="metadata" ${work.coverUrl ? `poster="${work.coverUrl}"` : ""} src="${work.videoUrl}" aria-labelledby="${mediaTitleId}" data-avatar-video>当前浏览器无法播放该视频。</video><span id="${mediaTitleId}" class="sr-only">${escapeHtml(job.title)}作品播放器</span></div>`
    : work?.simulation
      ? `<div class="avatar-detail-media-state simulation">${icon("check",24)}<strong>演示任务已完成</strong><span>这是一条流程演示记录，没有可播放的视频。</span></div>`
      : `<div class="avatar-detail-media-state ${job.status}">${icon(active ? "clock" : job.status === "failed" ? "alert" : "check",24)}<strong>${active ? avatarPhaseLabels[job.phase] || "处理中" : statusLabel}</strong><span>${active ? `当前进度 ${Math.min(100,job.progress || 0)}%` : "这条任务没有可播放的视频。"}</span>${active ? `<div class="progress"><span style="width:${Math.min(100,job.progress || 0)}%"></span></div>` : ""}</div>`;
  const providerUpdatedAt = metadata.providerUpdatedAt ? formatDate(new Date(Number(metadata.providerUpdatedAt) * 1000).toISOString()) : "—";
  const model = metadata.model || ui.avatarRuntime?.model || "MiniMax-H3";
  const mode = job.mode === "reference_avatar" ? "参考人物口播（reference_avatar）" : job.mode || "—";
  const workKind = work?.simulation ? "演示作品" : work ? "AI分身视频" : "尚未生成";
  const footer = active
    ? `<button class="btn" data-action="modal-close">关闭</button><button class="btn" data-action="avatar-detail-refresh" data-id="${escapeHtml(job.generationJobId)}">${icon("refresh",13)}刷新状态</button><button class="btn danger" data-action="avatar-cancel-job-detail" data-id="${escapeHtml(job.generationJobId)}">取消任务</button>`
    : `<button class="btn" data-action="modal-close">关闭</button>${work?.videoUrl && !identityNeedsReview ? `<a class="btn soft" href="${work.videoUrl}" download>${icon("download",13)}下载视频</a>` : ""}<button class="btn danger" data-action="avatar-delete-job" data-id="${escapeHtml(job.generationJobId)}">${icon("trash",13)}删除</button>`;
  openModal({
    title: escapeHtml(job.title),
    desc: `${escapeHtml(job.physicianName)} · ${statusLabel} · ${job.providerMode === "real" ? "正式作品" : "演示作品"}`,
    wide:true,
    body:`<div class="avatar-detail">
      <section class="avatar-detail-media">${media}<div class="avatar-player-help">视频按原始比例完整显示，不会自动播放。</div></section>
      <section class="avatar-detail-status"><div><span>任务状态</span>${badge(statusLabel,tone)}</div><div><span>当前阶段</span><strong>${escapeHtml(avatarPhaseLabels[job.phase] || "状态更新中")}</strong></div><div><span>处理进度</span><strong>${Math.min(100,job.progress || 0)}%</strong></div><div><span>最后更新</span><strong>${formatDate(job.updatedAt)}</strong></div></section>
      ${identityNeedsReview ? `<div class="risk-banner avatar-identity-review-banner">${icon("alert",15)}<div><strong>形象待复核</strong><p>该作品仅保留用于内部播放与形象复核，发布前不可使用；完成复核前暂不提供下载。</p></div></div>` : ""}
      ${job.error ? `<div class="risk-banner avatar-detail-error">${icon("alert",15)}<div><strong>视频未能完成</strong><p>${escapeHtml(avatarBusinessError(job.error, "请稍后重试；如多次失败，请联系管理员。"))}</p></div></div>` : ""}
      <section class="avatar-detail-script"><div class="avatar-detail-heading">完整口播内容</div><p>${escapeHtml(job.script)}</p></section>
      <div class="avatar-detail-sections">
        <section class="avatar-detail-panel"><div class="avatar-detail-heading">视频信息</div>${avatarDetailRows([
          ["作品类型",workKind],["清晰度",job.resolution || metadata.resolution || "—"],["画面比例",job.ratio || metadata.ratio || "—"],
          ["成片时长",durationInfo.detailLabel],["创建时间",formatDate(job.createdAt)],["文件大小",formatAvatarBytes(metadata.size)]
        ])}</section>
        <section class="avatar-detail-panel"><div class="avatar-detail-heading">生成记录</div>${avatarDetailRows([
          ["医师形象",job.physicianName || "—"],["播报声音",job.voiceName || "系统合成声音"],["完成时间",work?.createdAt ? formatDate(work.createdAt) : "—"],
          ["最后更新",formatDate(job.updatedAt)]
        ])}</section>
      </div>
      ${store.state.currentRole === "管理者" ? `<details class="avatar-detail-panel"><summary class="avatar-detail-heading">系统信息（仅管理员排查）</summary><div class="avatar-detail-sections" style="margin-top:12px">
        <section>${avatarDetailRows([
          ["任务 ID",job.generationJobId],["供应商任务 ID",job.providerTaskId || "待提交"],["作品 ID",job.workId || work?.workId || "尚未创建"],
          ["参考素材 fileId",job.referenceFileId || "—"],["输入音频 fileId",job.audioFileId || "—"],["形象 avatarId",job.avatarId || "—"],["音色 voiceId",job.voiceId || "—"]
        ])}</section>
        <section>${avatarDetailRows([
          ["模型",model],["API 版本",metadata.apiVersion || "v2"],["生成模式",mode],["供应商状态",job.providerStatus || "—"],
          ["原始阶段",job.phase || "—"],["MIME",metadata.mime || "—"],["媒体清晰度",metadata.resolution || "—"],["媒体比例",metadata.ratio || "—"],
          ["封面来源",metadata.cover?.source || "—"],["封面大小",formatAvatarBytes(metadata.cover?.size)],["供应商更新",providerUpdatedAt],
          ["失败补偿",job.refundStatus || "—"],["原始错误",job.error ? `${job.error.code || ""} ${job.error.message || ""}`.trim() : "—"]
        ])}</section>
      </div></details>` : ""}
    </div>`,
    footer
  });
}

async function openAvatarJobDetail(generationJobId, trigger) {
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.setAttribute("aria-busy","true"); trigger.textContent = "读取中…"; }
  try {
    showAvatarJobDetail(await fetchAvatarJob(generationJobId));
  } catch (error) {
    if (error.code !== "AVATAR_SCOPE_MISMATCH") toast(avatarBusinessError(error, "暂时无法读取这条任务，请稍后重试。"), "danger");
  } finally {
    if (trigger?.isConnected) { trigger.disabled = false; trigger.removeAttribute("aria-busy"); trigger.innerHTML = original; }
  }
}

function currentScopedAvatarJob(generationJobId) {
  const physicianId = routeAvatarPhysician()?.id;
  if (!physicianId || ui.avatarJobsPhysicianId !== physicianId) return null;
  return ui.avatarJobs.find((item) => item.generationJobId === generationJobId && item.physicianId === physicianId) || null;
}

function showDeleteAvatarJobModal(generationJobId) {
  const job = currentScopedAvatarJob(generationJobId);
  if (!job) return toast("未找到这条任务，请刷新后重试。", "danger");
  if (!avatarTerminalStatuses.has(job.status)) return toast("正在生成的任务需先取消，之后才能删除。", "warning");
  const hasWork = Boolean(job.workId || job.work);
  const actionLabel = hasWork ? "删除任务和作品" : "删除任务记录";
  openModal({
    title: hasWork ? "删除任务和作品？" : "删除任务记录？",
    desc: "请确认删除范围，该操作无法恢复。",
    role:"alertdialog",
    initialFocus:"#avatar-delete-cancel",
    body:`<div class="avatar-delete-confirm" data-avatar-delete-job="${escapeHtml(job.generationJobId)}">
      <div class="risk-banner avatar-delete-warning">${icon("alert",16)}<div><strong>删除后不可恢复</strong><p>将删除「${escapeHtml(job.title)}」的${hasWork ? "任务和生成视频" : "任务记录"}。</p></div></div>
      <div class="avatar-delete-facts"><div><span>所属医师</span><strong>${escapeHtml(job.physicianName || "—")}</strong></div><div><span>当前状态</span><strong>${escapeHtml(avatarStatusMeta[job.status]?.[0] || "已结束")}</strong></div></div>
      <ul><li>医师参考图不会受到影响。</li><li>系统仍会保留本次操作记录。</li><li>已开始的生成不会因删除而撤销，已经产生的费用不会退回。</li></ul>
    </div>`,
    footer:`<button class="btn" id="avatar-delete-cancel" data-action="modal-close">取消</button><button class="btn danger" data-action="avatar-confirm-delete" data-id="${escapeHtml(job.generationJobId)}">${icon("trash",13)}${actionLabel}</button>`
  });
}

async function deleteAvatarJob(generationJobId, trigger) {
  const job = currentScopedAvatarJob(generationJobId);
  if (!job) return toast("这条任务不在当前医师的作品列表中，请刷新后重试。", "danger");
  const physicianId = job.physicianId;
  const physicianName = job.physicianName || store.physician(physicianId)?.name || "该医师";
  const physician = store.physician(physicianId) || { id:physicianId, name:physicianName };
  const scopeEpoch = ui.avatarScopeEpoch;
  const previousJobs = [...ui.avatarJobs];
  beginAvatarMutation(physicianId);
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.setAttribute("aria-busy","true"); trigger.textContent = "正在删除…"; }
  try {
    const response = await fetch(`/api/local/physician-avatar/jobs/${encodeURIComponent(generationJobId)}?physician_id=${encodeURIComponent(physicianId)}`, { method:"DELETE", headers:avatarApiHeaders });
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(avatarBusinessError(body.error, "暂时无法删除，请稍后重试。"));
    if (avatarScopeMatches(physicianId, scopeEpoch)) {
      ui.avatarJobs = ui.avatarJobs.filter((item) => item.generationJobId !== generationJobId);
      ui.avatarHydratedAt = Date.now();
      patchAvatarStudioDom(physician, previousJobs, ui.avatarJobs);
    }
    const sameDeleteModal = document.querySelector("#modal-root [data-avatar-delete-job]")?.dataset.avatarDeleteJob === generationJobId;
    if (avatarScopeMatches(physicianId, scopeEpoch) && sameDeleteModal) closeModal();
    const mediaCleanupCompleted = body.data?.cleanupStatus === "completed";
    if (avatarScopeMatches(physicianId, scopeEpoch)) toast(mediaCleanupCompleted
      ? `${physicianName}的任务和相关视频已删除`
      : `${physicianName}的任务已从列表移除，相关文件正在清理`,
    mediaCleanupCompleted ? "success" : "warning");
  } catch (error) {
    if (avatarScopeMatches(physicianId, scopeEpoch)) toast(avatarBusinessError(error, "暂时无法删除，请稍后重试。"), "danger");
    if (trigger?.isConnected) { trigger.disabled = false; trigger.removeAttribute("aria-busy"); trigger.innerHTML = original; }
  } finally {
    finishAvatarMutation(physicianId, scopeEpoch);
  }
}

function openAvatarVideo(jobId) {
  const job = currentScopedAvatarJob(jobId);
  const work = job?.work;
  if (!job || !work?.videoUrl) return toast("该作品暂时没有可播放的视频", "warning");
  const ratio = avatarMediaRatio(work.metadata?.ratio || job.ratio);
  const titleId = `avatar-player-title-${escapeHtml(job.generationJobId)}`;
  const videoUrl = escapeHtml(work.videoUrl);
  const poster = work.coverUrl ? ` poster="${escapeHtml(work.coverUrl)}"` : "";
  const duration = formatAvatarClockDuration(avatarDurationPresentation(job).value);
  const identityNeedsReview = avatarIdentityReviewStatus(job) === "needs_review";
  openModal({
    title: `AI分身视频：${escapeHtml(job.physicianName)} · ${escapeHtml(job.title)}`,
    desc: identityNeedsReview ? `形象待复核 · 仅供内部复核，发布前不可使用` : `视频时长 ${duration} · 完整画面按原始比例显示`,
    wide:true,
    className:"avatar-video-modal",
    headerIcon:icon("spark",18),
    body: `<div class="avatar-player-stage avatar-preview-player-stage ${ratio.portrait ? "is-portrait" : ""}" style="--avatar-media-ratio:${ratio.value}"><video class="avatar-player-video" controls playsinline preload="metadata"${poster} src="${videoUrl}" aria-labelledby="${titleId}" tabindex="0" data-avatar-video>当前浏览器无法播放该视频。</video><span id="${titleId}" class="sr-only">${escapeHtml(job.physicianName)}的${escapeHtml(job.title)}视频播放器，完整画面按原始比例显示且不会自动播放</span></div>`,
    footer:`<button class="btn avatar-player-cancel" data-action="modal-close">取消</button><button class="btn primary avatar-player-detail-button" data-action="avatar-view-job" data-id="${escapeHtml(job.generationJobId)}">查看详情</button>`
  });
}

function avatarJobCard(job) {
  const physician = store.physician(job.physicianId) || { name:job.physicianName };
  const [statusLabel] = avatarStatusMeta[job.status] || ["状态更新中","outline"];
  const work = job.work;
  const active = ["queued","processing"].includes(job.status);
  const identityNeedsReview = avatarIdentityReviewStatus(job) === "needs_review";
  const ratioLabel = avatarRatioLabel(work?.metadata?.ratio || job.ratio || "自动适配");
  const durationLabel = avatarDurationPresentation(job).value || "—";
  const resolutionLabel = work?.metadata?.resolution || job.resolution || "—";
  const statusClass = ["queued","processing","completed","failed","cancelled"].includes(job.status) ? job.status : "unknown";
  const mediaKind = work?.videoUrl ? "AI分身视频" : active ? "生成中" : "任务记录";
  const videoDescriptionId = `avatar-video-desc-${escapeHtml(job.generationJobId)}`;
  const coverUrl = work?.coverUrl ? escapeHtml(work.coverUrl) : "";
  const videoUrl = work?.videoUrl ? escapeHtml(work.videoUrl) : "";
  const mediaBackdrop = coverUrl ? `<img class="avatar-card-backdrop" src="${coverUrl}" alt="" aria-hidden="true" loading="lazy" />` : "";
  const media = work?.videoUrl
    ? `${mediaBackdrop}<video class="avatar-work-video" muted playsinline preload="metadata" ${coverUrl ? `poster="${coverUrl}"` : ""} src="${videoUrl}" aria-hidden="true" tabindex="-1" data-avatar-video>当前浏览器无法播放该视频。</video><button class="avatar-media-open" data-action="avatar-open-video" data-id="${escapeHtml(job.generationJobId)}" aria-describedby="${videoDescriptionId}" aria-label="预览${escapeHtml(job.title)}"><span>${icon("play",12)}预览</span></button><span id="${videoDescriptionId}" class="sr-only">${escapeHtml(ratioLabel)}，${escapeHtml(durationLabel)}秒，弹窗内按原始比例完整播放</span>`
    : work?.simulation
      ? `<div class="avatar-simulation-result">${icon("check",22)}<strong>演示任务已完成</strong><span>此记录仅用于体验生成流程，没有可播放的视频。</span></div>`
      : `<div class="avatar-work-placeholder">${physicianAvatar(physician,"xl")}<span>${active ? "正在生成，暂显示医师参考图" : "医师参考图"}</span><small>${active ? "成片完成后会自动更新" : "这不是最终视频封面"}</small></div>`;
  return `<article class="card avatar-job-card status-${statusClass}" data-avatar-job-id="${escapeHtml(job.generationJobId)}">
    <div class="avatar-job-media">${media}<span class="avatar-media-kind">${icon("play",11)}${mediaKind}</span><span class="avatar-card-status ${statusClass}">${escapeHtml(statusLabel)}</span></div>
    <div class="avatar-job-content"><div class="avatar-gallery-copy"><div class="card-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
      <p class="avatar-job-script">${escapeHtml(job.script)}</p>
    </div><div class="avatar-gallery-specs"><span>${icon("spark",11)}${job.providerMode === "real" ? "AI生成" : "演示作品"}</span><span>${escapeHtml(resolutionLabel)} · ${escapeHtml(durationLabel)}秒 · ${escapeHtml(ratioLabel)}</span></div>
      ${active ? `<div class="avatar-progress"><div class="row between"><span>${avatarPhaseLabels[job.phase] || "处理中"}</span><strong>${job.progress || 0}%</strong></div><div class="progress" role="progressbar" aria-label="视频生成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,job.progress || 0)}"><span style="width:${Math.min(100,job.progress || 0)}%"></span></div></div>` : ""}
      ${identityNeedsReview ? `<div class="avatar-identity-review-warning">${icon("alert",13)}<span><strong>形象待复核</strong><small>仅供内部复核，发布前不可使用</small></span></div>` : ""}
      ${job.error ? `<div class="avatar-gallery-error">${icon("alert",13)}<span>${escapeHtml(avatarBusinessError(job.error, "视频未能完成，请查看详情。"))}</span></div>` : ""}
      <div class="avatar-card-footer"><div class="avatar-card-author">${physicianAvatar(physician,"sm")}<span><strong>${escapeHtml(job.physicianName)}</strong><small>${escapeHtml(physician.title || "医师AI分身")}</small></span></div>
      <div class="avatar-job-actions"><button class="btn small avatar-gallery-view" data-action="avatar-view-job" data-id="${escapeHtml(job.generationJobId)}">${icon("eye",13)}查看详情</button>${active ? `<button class="btn small avatar-gallery-icon" data-action="avatar-refresh-job" data-id="${escapeHtml(job.generationJobId)}" aria-label="刷新${escapeHtml(job.title)}状态" title="刷新状态">${icon("refresh",13)}</button><button class="btn small danger" data-action="avatar-cancel-job" data-id="${escapeHtml(job.generationJobId)}">取消</button>` : avatarTerminalStatuses.has(job.status) ? `<button class="btn small danger avatar-delete-action avatar-gallery-icon" data-action="avatar-delete-job" data-id="${escapeHtml(job.generationJobId)}" aria-label="删除${escapeHtml(job.title)}" title="删除">${icon("trash",13)}</button>` : ""}</div></div>
    </div>
  </article>`;
}

function avatarStudioCounts(jobs) {
  return Object.fromEntries(["queued","processing","completed","failed"].map((status) => [status,jobs.filter((job) => job.status === status).length]));
}

function avatarStudioMetricsSignature(jobs) {
  const counts = avatarStudioCounts(jobs);
  return `${jobs.length}:${counts.queued || 0}:${counts.processing || 0}:${counts.completed || 0}:${counts.failed || 0}`;
}

function avatarStudioMetricsMarkup(physician, jobs) {
  const counts = avatarStudioCounts(jobs);
  return `${metric("全部任务",jobs.length,`仅显示${escapeHtml(physician.name)}的记录`,"spark")}${metric("排队 / 生成中",`${counts.queued || 0} / ${counts.processing || 0}`,"完成后自动进入作品列表","clock")}${metric("已完成作品",counts.completed || 0,"可预览和下载","check")}${metric("需要处理",counts.failed || 0,"可查看原因并重新创建","shield")}`;
}

function avatarJobStructureSignature(job) {
  const work = job.work || null;
  return JSON.stringify({
    statusGroup:["queued","processing"].includes(job.status) ? "active" : job.status,
    title:job.title,
    script:job.script,
    providerMode:job.providerMode,
    identityReviewStatus:avatarIdentityReviewStatus(job) || null,
    requestedDuration:job.requestedDuration || null,
    actualDuration:job.providerDuration || null,
    resolution:job.resolution,
    duration:job.duration,
    ratio:job.ratio,
    error:job.error ? { code:job.error.code, message:job.error.message } : null,
    work:work ? {
      workId:work.workId,
      videoUrl:work.videoUrl,
      coverUrl:work.coverUrl,
      simulation:work.simulation,
      metadata:work.metadata
    } : null
  });
}

function createAvatarJobElement(job) {
  const template = document.createElement("template");
  template.innerHTML = avatarJobCard(job).trim();
  return template.content.firstElementChild;
}

function patchAvatarJobProgress(card, job) {
  const progress = Math.min(100, Math.max(0, Number(job.progress) || 0));
  const statusClass = ["queued","processing","completed","failed","cancelled"].includes(job.status) ? job.status : "unknown";
  const [statusText] = avatarStatusMeta[job.status] || ["状态更新中"];
  const status = card.querySelector(".avatar-card-status");
  const phase = card.querySelector(".avatar-progress .row span");
  const value = card.querySelector(".avatar-progress .row strong");
  const bar = card.querySelector(".avatar-progress .progress");
  const fill = bar?.querySelector("span");
  const phaseText = avatarPhaseLabels[job.phase] || "处理中";
  const progressText = `${progress}%`;
  for (const value of ["queued","processing","completed","failed","cancelled","unknown"]) {
    card.classList.toggle(`status-${value}`, value === statusClass);
    status?.classList.toggle(value, value === statusClass);
  }
  if (status && status.textContent !== statusText) status.textContent = statusText;
  if (phase && phase.textContent !== phaseText) phase.textContent = phaseText;
  if (value && value.textContent !== progressText) value.textContent = progressText;
  if (bar && bar.getAttribute("aria-valuenow") !== String(progress)) bar.setAttribute("aria-valuenow", String(progress));
  if (fill && fill.style.width !== progressText) fill.style.width = progressText;
}

function notifyAvatarJobTransitions(previousJobs, nextJobs) {
  const previousById = new Map(previousJobs.map((job) => [job.generationJobId, job]));
  for (const job of nextJobs) {
    const previous = previousById.get(job.generationJobId);
    if (!previous || !["queued","processing"].includes(previous.status) || previous.status === job.status) continue;
    if (job.status === "completed") toast(`${job.physicianName}的视频已生成完成`, "success");
    if (job.status === "failed") toast(`${job.physicianName}的视频未能完成，可查看原因后重新创建`, "danger");
  }
}

function patchAvatarStudioDom(physician, previousJobs, nextJobs) {
  if (!avatarScopeMatches(physician.id)) return false;
  const page = [...document.querySelectorAll("[data-avatar-studio-physician]")].find((item) => item.dataset.avatarStudioPhysician === physician.id);
  if (!page) return false;

  const metrics = page.querySelector("[data-avatar-metrics]");
  const metricsSignature = avatarStudioMetricsSignature(nextJobs);
  if (metrics && metrics.dataset.avatarMetricsSignature !== metricsSignature) {
    metrics.innerHTML = avatarStudioMetricsMarkup(physician, nextJobs);
    metrics.dataset.avatarMetricsSignature = metricsSignature;
  }

  const count = page.querySelector("[data-avatar-works-count]");
  if (count && count.dataset.avatarWorksCount !== String(nextJobs.length)) {
    count.innerHTML = badge(`${nextJobs.length} 条记录`, "outline");
    count.dataset.avatarWorksCount = String(nextJobs.length);
  }

  const grid = page.querySelector("[data-avatar-job-grid]");
  if (!grid) return false;
  if (!nextJobs.length) {
    if (previousJobs.length || grid.dataset.avatarEmptyState !== "empty") {
      grid.innerHTML = empty(`${escapeHtml(physician.name)}暂无任务或作品`,"在上方填写口播内容，提交后可在这里查看进度");
      grid.dataset.avatarEmptyState = "empty";
    }
    return true;
  }
  if (grid.querySelector(".empty")) grid.replaceChildren();
  delete grid.dataset.avatarEmptyState;

  const previousById = new Map(previousJobs.map((job) => [job.generationJobId, job]));
  const elementsById = new Map([...grid.querySelectorAll("[data-avatar-job-id]")].map((element) => [element.dataset.avatarJobId, element]));
  const nextIds = new Set(nextJobs.map((job) => job.generationJobId));
  for (const [jobId, element] of elementsById) {
    if (!nextIds.has(jobId)) {
      element.remove();
      elementsById.delete(jobId);
    }
  }

  nextJobs.forEach((job, index) => {
    const previous = previousById.get(job.generationJobId);
    let element = elementsById.get(job.generationJobId);
    if (!element) {
      element = createAvatarJobElement(job);
      elementsById.set(job.generationJobId, element);
    } else if (!previous || avatarJobStructureSignature(previous) !== avatarJobStructureSignature(job)) {
      const replacement = createAvatarJobElement(job);
      element.replaceWith(replacement);
      element = replacement;
      elementsById.set(job.generationJobId, element);
    } else {
      patchAvatarJobProgress(element, job);
    }
    const currentAtIndex = grid.children[index];
    if (currentAtIndex !== element) grid.insertBefore(element, currentAtIndex || null);
  });
  return true;
}

function currentAvatarStudioPage(physicianId) {
  return [...document.querySelectorAll("[data-avatar-studio-physician]")].find((item) => item.dataset.avatarStudioPhysician === physicianId) || null;
}

function patchAvatarRuntimeDom(physicianId) {
  const page = currentAvatarStudioPage(physicianId);
  if (!page || !ui.avatarRuntime) return;
  const realAccess = Boolean(ui.avatarRuntime.realAccess);
  const orb = page.querySelector("[data-avatar-runtime-orb]");
  const description = page.querySelector("[data-avatar-runtime-description]");
  const badges = page.querySelector("[data-avatar-runtime-badges]");
  if (orb) {
    orb.classList.toggle("online", realAccess);
    orb.classList.toggle("simulation", !realAccess);
  }
  if (description) description.textContent = realAccess ? "服务正常，可创建并保存视频作品" : "当前为演示模式，用于体验任务流程";
  if (badges) badges.innerHTML = `${badge(realAccess ? "服务正常" : "演示模式",realAccess ? "success" : "warning")}${badge("任务自动处理","outline")}${badge("离开页面后仍会继续生成","success")}`;
}

function patchAvatarComposerBusyDom(physicianId) {
  const page = currentAvatarStudioPage(physicianId);
  const submit = page?.querySelector(".avatar-submit");
  if (!submit) return;
  const submitting = ui.avatarSubmittingPhysicianId === physicianId;
  const busy = submitting || Boolean(ui.avatarMutationCounts[physicianId]) || (ui.avatarLoading && ui.avatarLoadingPhysicianId === physicianId);
  submit.disabled = busy;
  submit.innerHTML = `${icon("spark",15)}${submitting ? "正在开始生成…" : ui.avatarLoading && ui.avatarLoadingPhysicianId === physicianId ? "正在读取作品…" : "开始生成视频"}`;
}

function patchAvatarLoadingDom(physician, loading) {
  const page = currentAvatarStudioPage(physician.id);
  if (!page) return;
  const count = page.querySelector("[data-avatar-works-count]");
  const grid = page.querySelector("[data-avatar-job-grid]");
  if (loading) {
    if (count) count.innerHTML = badge("更新中","info");
    if (grid && !ui.avatarJobs.length) {
      grid.innerHTML = empty(`正在读取${escapeHtml(physician.name)}的任务与作品`,"请稍候");
      grid.dataset.avatarEmptyState = "loading";
    }
  } else if (count) {
    count.innerHTML = badge(`${ui.avatarJobs.length} 条记录`,"outline");
    count.dataset.avatarWorksCount = String(ui.avatarJobs.length);
  }
  patchAvatarComposerBusyDom(physician.id);
}

function patchAvatarLoadErrorDom(physician) {
  const page = currentAvatarStudioPage(physician.id);
  const count = page?.querySelector("[data-avatar-works-count]");
  const grid = page?.querySelector("[data-avatar-job-grid]");
  if (count) count.innerHTML = badge("读取失败","danger");
  if (grid && !ui.avatarJobs.length) {
    grid.innerHTML = empty("任务与作品读取失败",ui.avatarLoadError);
    grid.dataset.avatarEmptyState = "error";
  }
}

function physicianAvatarPickerPage() {
  const physicians = store.state.physicians;
  return `<div class="page">${pageHead("AI分身工作室", "选择医师", "选择医师后，为其创建和管理独立的AI分身视频作品。", `<a class="btn" href="#/physicians">返回医师团队</a>`)}${moduleSubnav("physicians","avatar")}
    <section class="card avatar-picker-panel"><div class="card-head"><div><div class="card-title">选择医师形象</div><div class="card-subtitle">每位医师的内容、任务和作品单独管理</div></div>${badge(`${physicians.length} 位医师`,"outline")}</div>
      <div class="avatar-physician-picker-grid">${physicians.length ? physicians.map((physician) => `<article class="avatar-physician-picker-card"><div class="avatar-picker-portrait">${physicianAvatar(physician,"xl")}<span>${badge(physician.status,physician.status === "出诊中" ? "success" : "outline")}</span></div><div class="avatar-picker-copy"><div class="eyebrow">AI分身视频</div><h3>${escapeHtml(physician.name)}</h3><p>${escapeHtml(physician.title)} · ${escapeHtml(physician.department)}</p><div class="skill-list">${physician.signatureProjects.slice(0,3).map((item) => badge(item,"outline")).join("")}</div></div><button class="btn primary" data-action="physician-avatar" data-id="${escapeHtml(physician.id)}">${icon("spark",14)}进入${escapeHtml(physician.name)}的工作室</button></article>`).join("") : empty("暂无可选医师","请先返回医师管理新增医师档案")}</div>
    </section>
  </div>`;
}

function physicianAvatarMissingPage(physicianId) {
  return `<div class="page">${pageHead("AI分身工作室", "无法打开医师工作室", "该医师档案不存在或已删除，请选择其他医师。", `<a class="btn" href="${avatarStudioHash()}">重新选择医师</a><a class="btn primary" href="#/physicians">返回医师团队</a>`)}${moduleSubnav("physicians","avatar")}
    <section class="card">${empty("医师不存在","请选择其他医师，或返回医师管理检查档案")}</section>
  </div>`;
}

function physicianAvatarStudioPage(physician) {
  const runtime = ui.avatarRuntime;
  const constraints = runtime?.constraints?.modes?.find((item) => item.id === "reference_avatar") || { resolutions:["768P","2K"], ratios:["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"], duration:{ min:4,max:15 } };
  const jobs = ui.avatarJobsPhysicianId === physician.id ? ui.avatarJobs.filter((job) => job.physicianId === physician.id) : [];
  const runtimeLabel = runtime?.realAccess ? "服务正常" : "演示模式";
  const runtimeTone = runtime?.realAccess ? "success" : "warning";
  const runtimeDescription = runtime?.realAccess ? "服务正常，可创建并保存视频作品" : "当前为演示模式，用于体验任务流程";
  const draft = avatarDraftFor(physician);
  const voices = avatarVoiceOptions(runtime?.voices, draft.voiceId);
  const preferredVoiceId = avatarDefaultVoiceId(physician.gender);
  const selectedVoiceId = voices.some((voice) => voice.id === draft.voiceId) ? draft.voiceId : voices.some((voice) => voice.id === preferredVoiceId) ? preferredVoiceId : voices[0]?.id || "";
  const referenceFileId = physicianAvatarReferenceFileId(physician);
  const scopeLoading = ui.avatarLoading && ui.avatarLoadingPhysicianId === physician.id;
  const scopeSubmitting = ui.avatarSubmittingPhysicianId === physician.id;
  const scopeBusy = scopeLoading || scopeSubmitting || Boolean(ui.avatarMutationCounts[physician.id]);
  return `<div class="page" data-avatar-studio-physician="${escapeHtml(physician.id)}">${pageHead("AI分身工作室", `${escapeHtml(physician.name)} · AI分身工作室`, `为${escapeHtml(physician.name)}创建口播视频，并集中查看生成进度与历史作品。`, `<button class="btn" data-action="avatar-refresh">${icon("refresh",15)}刷新作品</button><a class="btn" href="#/physician/${encodeURIComponent(physician.id)}">返回医师档案</a><a class="btn soft" href="${avatarStudioHash()}">切换医师</a>`)}
    <div class="avatar-runtime-bar" data-avatar-runtime-bar><div class="row"><span class="runtime-orb ${runtime?.realAccess ? "online" : "simulation"}" data-avatar-runtime-orb></span><div><strong>AI视频生成服务</strong><p data-avatar-runtime-description>${runtimeDescription}</p></div></div><div class="row wrap" data-avatar-runtime-badges>${badge(runtimeLabel,runtimeTone)}${badge("任务自动处理","outline")}${badge("离开页面后仍会继续生成","success")}</div></div>
    <div class="grid cols-4 avatar-studio-metrics" data-avatar-metrics data-avatar-metrics-signature="${avatarStudioMetricsSignature(jobs)}">${avatarStudioMetricsMarkup(physician,jobs)}</div>
    <div class="avatar-studio-layout">
      <section class="card avatar-composer"><div class="card-head"><div><div class="card-title">为${escapeHtml(physician.name)}创建AI分身视频</div><div class="card-subtitle">填写口播内容并选择画面设置，完成后请先审核再发布</div></div>${badge("发布前需审核","ai")}</div>
        <form id="physician-avatar-form" class="avatar-form" data-physician-id="${escapeHtml(physician.id)}"><div class="avatar-locked-physician full">${physicianReferenceImage(physician,"lg")}<div><span class="form-label">当前医师形象</span><strong>${escapeHtml(physician.name)}</strong><small>${escapeHtml(physician.title)} · ${escapeHtml(physician.department)}</small></div><span class="spacer"></span>${badge(referenceFileId ? "已绑定生成素材" : "暂无生成素材",referenceFileId ? "success" : "warning")}</div><input type="hidden" name="physicianId" value="${escapeHtml(physician.id)}" /><input type="hidden" name="referenceFileId" value="${escapeHtml(referenceFileId)}" />
          <label class="form-group full"><span class="form-label">作品标题</span><input class="form-control" id="avatar-title" name="title" maxlength="60" value="${escapeHtml(draft.title)}" required /></label>
          <label class="form-group full"><span class="form-label row between"><span>口播内容</span><small id="avatar-script-count">${Array.from(draft.script).length}/90</small></span><textarea class="form-control avatar-script-input" id="avatar-script" name="script" minlength="12" maxlength="90" required>${escapeHtml(draft.script)}</textarea><small>仅用于一般项目讲解与机构服务信息，不得诊断、判断适用性或承诺效果。</small></label>
          <label class="form-group full"><span class="form-label">播报声音</span><select class="form-control" id="avatar-voice-id" name="voiceId">${voices.map((voice) => `<option value="${escapeHtml(voice.id)}" ${voice.id===selectedVoiceId?"selected":""}>${escapeHtml(voice.name)}${voice.compatibilityLabel ? `（${escapeHtml(voice.compatibilityLabel)}）` : ""} · 非本人原声</option>`).join("")}</select></label>
          <div class="avatar-parameter-grid"><label class="form-group"><span class="form-label">清晰度</span><select class="form-control" id="avatar-resolution" name="resolution">${constraints.resolutions.map((value) => `<option ${value===draft.resolution?"selected":""}>${value}</option>`).join("")}</select></label><label class="form-group"><span class="form-label">预计时长</span><select class="form-control" id="avatar-duration" name="duration">${Array.from({length:constraints.duration.max-constraints.duration.min+1},(_,index)=>constraints.duration.min+index).map((value) => `<option value="${value}" ${Number(value)===Number(draft.duration)?"selected":""}>${value} 秒</option>`).join("")}</select><small>成片会自动匹配实际口播时长（4–15秒）</small></label><label class="form-group"><span class="form-label">画面比例</span><select class="form-control" id="avatar-ratio" name="ratio">${constraints.ratios.map((value) => `<option value="${value}" ${value===draft.ratio?"selected":""}>${avatarRatioLabel(value)}</option>`).join("")}</select></label></div>
          <input type="hidden" name="mode" value="reference_avatar" />
          <div class="avatar-consistency-guard full" role="status" aria-label="形象一致保护已开启"><span class="avatar-consistency-icon">${icon("shield",15)}</span><strong>形象一致保护已开启</strong></div>
          <label class="avatar-consent"><input type="checkbox" name="consentConfirmed" value="true" required /><span><strong>已获得医师肖像与内容使用授权</strong><small>授权范围应覆盖AI生成、发布渠道、使用期限与撤回机制。</small></span></label>
          <label class="avatar-consent"><input type="checkbox" name="generativeDisclosureConfirmed" value="true" required /><span><strong>已知晓成片由AI生成</strong><small>形象一致性保护会优先保持人物外观，但无法保证逐帧完全一致，发布前必须人工审核。</small></span></label>
          <div class="guardrail">${icon("shield",14)}AI生成内容发布前需人工审核；涉及个体适用性、诊断或效果承诺的内容不得发布。</div>
          <button class="btn primary avatar-submit" type="submit" ${scopeBusy?"disabled":""}>${icon("spark",15)}${scopeSubmitting?"正在开始生成…":scopeLoading?"正在更新作品列表…":"开始生成视频"}</button>
        </form>
      </section>
      <aside class="stack avatar-studio-side"><section class="card avatar-preview-card"><div class="avatar-preview-photo">${physicianReferenceImage(physician,"xl")}<span>${badge("本次生成素材","outline")}</span></div><div class="avatar-preview-copy"><div class="eyebrow">医师参考形象</div><h2>${escapeHtml(physician.name)}</h2><p>${escapeHtml(physician.title)} · ${escapeHtml(physician.department)}</p><div class="skill-list">${physician.signatureProjects.slice(0,3).map((item)=>badge(item,"brand")).join("")}</div></div><div class="avatar-preview-note"><strong>形象一致性保护已开启</strong><span>固定镜头 · 自然口播 · 真实肤质</span><p>本次生成将直接使用上图作为参考素材，但仍无法保证逐帧完全一致；作品发布前必须人工审核。</p></div></section>
        ${card("生成流程", `<div class="avatar-pipeline">${[["01","确认医师与口播内容","queued"],["02","开始生成视频","processing"],["03","自动更新生成进度","processing"],["04","保存视频与封面","processing"],["05","生成作品","completed"]].map(([no,title,status])=>`<div><span>${no}</span><strong>${title}</strong>${badge(avatarStatusMeta[status][0],avatarStatusMeta[status][1])}</div>`).join("")}</div>`, { subtitle:"提交后可离开页面，任务会继续处理" })}
        ${card("使用须知", `<div class="stack"><div class="row">${icon("check",15)}人物照片仅作为生成参考</div><div class="row">${icon("check",15)}播报声音为系统合成，并非医师本人原声</div><div class="row">${icon("alert",15)}人物一致性和口型可能存在偏差</div><div class="row">${icon("alert",15)}所有视频发布前必须人工审核</div></div>`, { subtitle:"请遵循肖像授权与医疗内容合规要求" })}
      </aside>
    </div>
    <section class="avatar-works-section"><div class="row between"><div><div class="eyebrow">作品管理</div><h2>${escapeHtml(physician.name)}的任务与作品</h2><p>查看生成进度、预览已完成视频，并管理历史任务。</p></div><span data-avatar-works-count="${jobs.length}" aria-live="polite">${scopeLoading?badge("更新中","info"):badge(`${jobs.length} 条记录`,"outline")}</span></div>
      <div class="avatar-job-grid" data-avatar-job-grid>${jobs.length ? jobs.map(avatarJobCard).join("") : scopeLoading ? empty(`正在读取${escapeHtml(physician.name)}的任务与作品`,"请稍候") : ui.avatarLoadError ? empty("任务与作品读取失败",ui.avatarLoadError) : empty(`${escapeHtml(physician.name)}暂无任务或作品`,"在上方填写口播内容，提交后可在这里查看进度")}</div>
    </section>
  </div>`;
}

function paginationItems(currentPage, totalPages) {
  if (totalPages <= 7) return Array.from({ length:totalPages }, (_, index) => index + 1);
  const pages = [...new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
  return pages.flatMap((page, index) => index && page - pages[index - 1] > 1 ? ["ellipsis", page] : [page]);
}

const listPageSizes = [10, 20, 50];

function listPaginationKey(listName, index = 0) {
  const { route, id, resourceId } = routeInfo();
  return [route || "workbench", id || "overview", resourceId || "", listName || `table-${index}`]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");
}

function listPaginationState(key, total) {
  const saved = ui.listPagination[key] || {};
  const pageSize = listPageSizes.includes(Number(saved.pageSize)) ? Number(saved.pageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(saved.page) || 1), totalPages);
  const state = { page, pageSize, totalPages };
  ui.listPagination[key] = state;
  return state;
}

function listPaginationMarkup({ key, page, pageSize, total, totalPages, variant = "table" }) {
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return `<div class="pagination-bar table-pagination ${variant === "collection" ? "collection-pagination" : ""}" data-pagination-key="${escapeHtml(key)}">
    <div class="pagination-summary"><span>显示 <strong>${start}–${end}</strong> / 共 ${total} 条</span><label class="page-size-control">每页<select class="select" data-pagination-size data-list-key="${escapeHtml(key)}" aria-label="每页条数">${listPageSizes.map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size}</option>`).join("")}</select>条</label></div>
    <nav class="pagination-controls" aria-label="列表分页">
      <button class="page-btn page-nav prev" data-action="list-page" data-list-key="${escapeHtml(key)}" data-id="${page - 1}" aria-label="上一页" ${page === 1 ? "disabled" : ""}>${icon("chevron",14)}</button>
      ${paginationItems(page,totalPages).map((item) => item === "ellipsis" ? `<span class="page-ellipsis" aria-hidden="true">…</span>` : `<button class="page-btn ${item === page ? "active" : ""}" data-action="list-page" data-list-key="${escapeHtml(key)}" data-id="${item}" ${item === page ? 'aria-current="page"' : ""}>${item}</button>`).join("")}
      <button class="page-btn page-nav" data-action="list-page" data-list-key="${escapeHtml(key)}" data-id="${page + 1}" aria-label="下一页" ${page === totalPages ? "disabled" : ""}>${icon("chevron",14)}</button>
    </nav>
  </div>`;
}

function mountListPagination({ key, items, anchor, host, variant = "table" }) {
  if (!items.length || !anchor || !host) return;
  const { page, pageSize, totalPages } = listPaginationState(key, items.length);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  items.forEach((item, index) => { item.hidden = index < start || index >= end; });
  // 分组列表（如会话收件箱按“待人工/人工接待/机器人/已结束”分组）需要同步隐藏空分组，
  // 否则翻页后会出现只剩标题的空分组。
  [...anchor.children]
    .filter((child) => !child.classList?.contains("table-pagination"))
    .forEach((group) => {
      const groupItems = items.filter((item) => group === item || group.contains(item));
      if (groupItems.length) group.hidden = groupItems.every((item) => item.hidden);
    });

  let pager = Array.from(host.children).find((child) => child.classList?.contains("table-pagination") && child.dataset.paginationKey === key);
  if (!pager) {
    pager = document.createElement("div");
    anchor.insertAdjacentElement("afterend", pager);
  }
  pager.outerHTML = listPaginationMarkup({ key, page, pageSize, total:items.length, totalPages, variant });
}

function hydrateListPagination() {
  const root = document.querySelector("#app");
  const { route } = routeInfo();
  if (!root || !moduleNavConfig[route]) return;

  const tables = [...root.querySelectorAll("table.data-table")]
    .filter((table) => !table.closest(".modal-backdrop") && table.tBodies[0]?.rows.length);
  tables.forEach((table, index) => {
    const anchor = table.closest(".table-wrap") || table;
    mountListPagination({
      key:listPaginationKey(`table-${index}`, index),
      items:[...table.tBodies[0].rows].filter(row=>!row.querySelector(".governance-empty-cell")),
      anchor,
      host:anchor.parentElement,
      variant:"table"
    });
  });

  [...root.querySelectorAll("[data-paginated-list]")].forEach((list, index) => {
    const itemSelector = list.dataset.paginationItem || "article";
    // 指定 data-pagination-item 时允许条目嵌在分组容器内（会话收件箱按状态分组），
    // 未指定时保持原有“直接子元素”语义。
    const items = list.dataset.paginationItem
      ? [...list.querySelectorAll(itemSelector)]
      : [...list.children].filter((item) => item.matches(itemSelector));
    mountListPagination({
      key:listPaginationKey(list.dataset.paginatedList || `collection-${index}`, index),
      items,
      anchor:list,
      host:list.parentElement,
      variant:"collection"
    });
  });
}

const knowledgeRiskLabel = (risk = "") => ({
  H3:"高风险 · 手术类", H2:"中风险 · 微创/注射", H1:"一般风险 · 光电/皮肤"
})[risk] || risk;

function knowledgeLayerLabel(layer = "") {
  if (String(layer).startsWith("L4")) return "强制合规边界";
  if (String(layer).startsWith("L2")) return "已审核业务知识";
  if (String(layer).startsWith("L1")) return "内部参考";
  if (String(layer).startsWith("L0")) return "待整理草稿";
  return layer;
}

const governanceStateBadge = (state = "") => ({
  approved_for_internal_catalog:["内部目录已批准","success"],
  not_activated:["尚未对客发布","warning"],
  active:["当前对客版本","success"],
  official_ready:["正式图谱已绑定","success"],
  bootstrap_only:["预构建图谱","warning"],
  not_built:["尚未建图","danger"]
}[state] || [state || "待确认","outline"]);

const governanceStage = (complete, title, description) => `<div class="governance-stage ${complete ? "done" : ""}"><span>${complete ? icon("check",14) : ""}</span><div><strong>${title}</strong><small>${description}</small></div></div>`;

function knowledgeGovernancePage() {
  const overview = ui.knowledgeGovernance;
  if (!overview) {
    return `<div class="card-body"><div class="governance-loading">${icon("refresh",16)}<div><strong>${ui.knowledgeGovernanceLoading ? "正在读取实际知识治理状态" : "知识治理状态尚未读取"}</strong><span>${ui.knowledgeGovernanceError ? "服务暂时不可用，请刷新后重试。" : "这里仅显示服务端已核验的知识范围、发布版本和图谱索引信息。"}</span></div>${ui.knowledgeGovernanceError ? `<button class="btn small" data-action="refresh-knowledge-governance">重新读取</button>` : ""}</div></div>`;
  }
  const internal = overview.internal_catalog || {};
  const release = overview.customer_release || {};
  const graph = overview.graph_index || {};
  const directIndex = overview.direct_qa_index || {};
  const activeRelease = release.active_release;
  const [internalLabel, internalTone] = governanceStateBadge(internal.admitted ? "approved_for_internal_catalog" : "not_activated");
  const [releaseLabel, releaseTone] = governanceStateBadge(activeRelease?.status || "not_activated");
  const [graphLabel, graphTone] = governanceStateBadge(graph.status);
  const formalGraphReady = graph.status === "official_ready" && graph.production_eligible === true;
  const pipeline = [
    governanceStage(internal.admitted, "内部目录入库", `${Number(internal.total_records || 0).toLocaleString()} 条知识单元`),
    governanceStage(Number(directIndex.documents || 0) > 0, "内部草稿索引", `${Number(directIndex.documents || 0).toLocaleString()} 份资料 / ${Number(directIndex.chunks || 0).toLocaleString()} 个向量块`),
    governanceStage(formalGraphReady, "正式图谱索引", formalGraphReady ? "正式索引已绑定" : "预构建索引不可替代正式发布"),
    governanceStage(release.ready && activeRelease?.status === "active", "图谱版本激活", activeRelease ? `版本 ${activeRelease.package_version || "待确认"}` : "日常问答不依赖图谱版本")
  ].join("");
  const releaseRows = (overview.recent_releases || []).map((item) => {
    const [statusLabel, statusTone] = governanceStateBadge(item.status);
    const reviews = item.review_status || {};
    const reviewText = [reviews.business, reviews.medical, reviews.compliance].map((value) => value === "approved" ? "通过" : "待审").join(" / ");
    return `<tr><td><strong>${escapeHtml(item.id || "—")}</strong><div class="caption">${escapeHtml(item.package_version || "未绑定知识包")}</div></td><td>${Number(item.approved_record_count || 0).toLocaleString()} 条</td><td>${badge(reviewText, reviews.business === "approved" && reviews.medical === "approved" && reviews.compliance === "approved" ? "success" : "warning")}</td><td>${escapeHtml(item.index_version || "尚未绑定")}</td><td>${badge(statusLabel,statusTone)}</td><td>${item.activated_at || item.effective_at ? formatDate(item.activated_at || item.effective_at) : "—"}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="governance-empty-cell">尚无 GraphRAG 对客发布记录。上传资料仅建立内部草稿索引，正式对客发布尚待完成。</td></tr>`;
  return `<div class="governance-panel">
    <div class="governance-panel-head"><div><div class="card-title">知识库与图谱状态</div><div class="card-subtitle">运营上传资料先形成内部草稿；正式对客知识须绑定发布包、索引与评测结果。</div></div><button class="btn small" data-action="refresh-knowledge-governance" ${ui.knowledgeGovernanceLoading ? "disabled" : ""}>${icon("refresh",14)}${ui.knowledgeGovernanceLoading ? "正在刷新" : "刷新状态"}</button></div>
    ${ui.knowledgeGovernanceError ? `<div class="risk-banner">${icon("alert",15)}<div>状态刷新失败，页面保留最近一次成功读取的结果；请确认知识服务连接和当前账号权限。</div></div>` : ""}
    <div class="grid cols-4 governance-metrics">
      ${metric("内部知识目录", Number(internal.total_records || 0).toLocaleString(), internal.admitted ? "已批准入库，仅供治理与加工" : "等待目录入库批准", "database")}
      ${metric("内部草稿资料", Number(directIndex.documents || 0).toLocaleString(), `${Number(directIndex.public_chunks || 0).toLocaleString()} 个已发布对客块`, "database")}
      ${metric("GraphRAG 发布版本", activeRelease ? String(activeRelease.approved_record_count || 0) : "—", activeRelease ? `已激活 ${activeRelease.package_version || "版本待确认"}` : "日常问答不依赖图谱版本", "check")}
      ${metric("图谱关系", Number(graph.relationship_count || 0).toLocaleString(), graph.engine === "official_graphrag_3_1_1" ? "正式 GraphRAG 索引" : "预构建索引，待正式发布", "route")}
    </div>
    <section class="governance-flow-card"><div class="row between"><div><strong>知识处理链路</strong><div class="caption">日常资料走自动解析与向量检索；只有关系发现与多跳问题才依赖独立 GraphRAG 索引。</div></div>${badge(releaseLabel,releaseTone)}</div><div class="governance-flow">${pipeline}</div></section>
    <div class="grid governance-detail-grid">
      <section class="card governance-detail-card"><div class="card-head"><div><div class="card-title">图谱索引状态</div><div class="card-subtitle">GraphRAG 只用于实体关系与多跳问题，不是所有咨询的默认检索链路。</div></div>${badge(graphLabel,graphTone)}</div><div class="card-body"><div class="profile-list"><div class="profile-row"><span class="profile-key">当前版本</span><strong>${escapeHtml(graph.version || "未构建")}</strong></div><div class="profile-row"><span class="profile-key">图谱引擎</span><span>${escapeHtml(graph.engine || "—")}</span></div><div class="profile-row"><span class="profile-key">实体 / 关系</span><span>${Number(graph.entity_count || 0).toLocaleString()} / ${Number(graph.relationship_count || 0).toLocaleString()}</span></div><div class="profile-row"><span class="profile-key">索引范围</span><span>${Number(graph.document_count || 0).toLocaleString()} 条对客候选知识</span></div></div><div class="guardrail">${icon("shield",14)}${formalGraphReady ? "该版本已满足正式图谱索引条件。" : "当前为预构建图谱；必须完成正式索引、三方审核与发布绑定后，才能作为生产对客证据。"}</div></div></section>
      <section class="card governance-detail-card"><div class="card-head"><div><div class="card-title">访问边界</div><div class="card-subtitle">上传资料只建立内部索引，对客知识由正式发布版本控制。</div></div>${badge(internalLabel,internalTone)}</div><div class="card-body"><div class="governance-boundaries"><div><span class="governance-boundary-mark allow">${icon("check",14)}</span><div><strong>智能体可读取</strong><small>正式激活版本内的对客资料，以及经授权的实时业务数据。</small></div></div><div><span class="governance-boundary-mark deny">${icon("shield",14)}</span><div><strong>智能体不可直读</strong><small>原始文件、解析失败资料、客户相关资料和标记为仅内部的内容。</small></div></div><div><span class="governance-boundary-mark note">${icon("alert",14)}</span><div><strong>时效信息单独核验</strong><small>价格、活动、排班、名额和可售型号必须带生效时间。</small></div></div></div></div></section>
    </div>
    <section class="card governance-releases"><div class="card-head"><div><div class="card-title">对客知识版本</div><div class="card-subtitle">展示已创建的对客发布记录；发布、审核和激活均由服务端实名流程执行。</div></div><span class="caption">更新于 ${formatDate(overview.retrieved_at)}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>发布版本</th><th>准入记录</th><th>三方审核</th><th>图谱索引</th><th>状态</th><th>生效时间</th></tr></thead><tbody>${releaseRows}</tbody></table></div></section>
  </div>`;
}

const knowledgeIntakeStatus = (value) => ({
  parsing_pending:["待受控解析", "warning"], draft:["内部草稿", "outline"],
  indexed:["内部草稿", "outline"], release_candidate:["候选待评测", "warning"]
}[value] || [value || "未知", "outline"]);
const knowledgeMissingLabels = { parsed_content:"解析正文", source_reference:"来源凭据", applicable_campuses:"适用院区",
  public_scope:"对客候选用途", effective_at:"生效日期", expires_at:"失效日期", hospital_confirmation:"本版本院方确认" };
const knowledgeVersionChangeLabels = {
  title:"标题", raw_text:"整理正文", department:"科室", content_type:"内容类型", owner:"负责人",
  tags:"标签", source_reference:"来源凭据", applicable_campuses:"适用院区", public_scope:"公开用途",
  customer_facing_candidate:"对客候选标记", effective_at:"生效日期", expires_at:"失效日期"
};

function knowledgeIntakePanel() {
  if (!knowledgeIntakeEnabled) return "";
  // 无权限不能静默消失：要让使用人知道是权限问题，而不是没有资料。
  if (!hasCapability("knowledge:read")) {
    return `<section class="card governance-releases" style="margin-bottom:16px"><div class="card-head"><div><div class="card-title">知识资料与发布准备</div><div class="card-subtitle">资料仅限被授权查看知识资料的岗位。</div></div></div><div class="risk-banner" style="margin:0 16px 16px">${icon("shield",14)}当前岗位没有“查看知识资料”的权限，资料列表不可见。如需处理资料，请由系统管理员调整岗位能力或改用有权限的账号。</div></section>`;
  }
  const documents = Array.isArray(ui.knowledgeIntakeDocuments) ? ui.knowledgeIntakeDocuments : [];
  const filterActive = Boolean(ui.knowledgeIntakeQuery || ui.knowledgeIntakeStatus || ui.knowledgeIntakeContentType || ui.knowledgeIntakePublicScope);
  const rows = documents.map((document) => {
    const [label, tone] = knowledgeIntakeStatus(document.status);
    const parseNeedsAttention = document.parser_status === "needs_attention";
    const parseLabel = parseNeedsAttention ? "解析待处理" : document.parser_status === "parsed" ? "解析完成" : "待受控解析";
    const indexState = indexStatusLabel(document.retrieval_index_status);
    const publication = summarizeDocumentPublicationStatus({ document, publications:ui.publications });
    const publicationCaption = publication.package_id ? `包 ${escapeHtml(publication.package_id)}` : "尚未进入任何发布包";
    const missing = (document.publication_readiness?.missing || []).map((key) => knowledgeMissingLabels[key] || key).join("、");
    const actions = !hasCapability("knowledge:manage") ? `<span class="caption">仅查看发布准备状态</span>` : `<div class="stack" style="gap:6px"><button class="btn small" data-action="edit-knowledge-intake" data-id="${escapeHtml(document.id)}">查看 / 校订</button>${document.parser_status === "parsed" ? `<button class="btn small" data-action="confirm-knowledge-intake" data-id="${escapeHtml(document.id)}">登记院方确认</button>` : ""}${document.publication_readiness?.ready && document.status !== "release_candidate" ? `<button class="btn small primary" data-action="candidate-knowledge-intake" data-id="${escapeHtml(document.id)}">准备发布候选</button>` : ""}</div>`;
    return `<tr><td><strong>${escapeHtml(document.title || document.source_filename)}</strong><div class="caption">${escapeHtml(document.source_filename)} · v${Number(document.version)}</div></td><td>${escapeHtml(document.department)}</td><td>${escapeHtml(document.content_type)}</td><td>${badge(parseLabel, document.parser_status === "parsed" ? "success" : "warning")} ${badge(indexState.label, indexState.tone)}<div class="caption">${Number(document.indexed_chunk_count || 0)} 个内部检索块</div></td><td>${badge(label,tone)}<div class="caption">${missing ? `待补：${escapeHtml(missing)}` : "待正式评测与发布"}</div></td><td>${badge(publication.label, publication.tone)}<div class="caption">${publicationCaption}</div></td><td>${formatDate(document.updated_at)}</td><td>${actions}</td></tr>`;
  }).join("") || `<tr><td colspan="8" class="governance-empty-cell">${filterActive ? "没有匹配的资料。可调整关键词或筛选条件，或点击上方“清除筛选”后再试。" : "暂无录入资料。上传后先保存为内部草稿。"}</td></tr>`;
  const typeOptions = ["", "项目介绍", "医生介绍", "服务流程", "活动权益", "公开海报", "排班说明", "其他"];
  const statusOptions = [["", "全部状态"], ["parsing_pending", "待受控解析"], ["draft", "内部草稿"], ["release_candidate", "候选待评测"]];
  const scopeOptions = [["", "全部用途"], ["internal", "仅内部"], ["customer_summary", "对客摘要候选"], ["public_full", "完整公开候选"]];
  return `<section class="card governance-releases" style="margin-bottom:16px"><div class="card-head"><div><div class="card-title">知识资料与发布准备</div><div class="card-subtitle">上传、校订、登记院方线下确认，再准备发布候选。资料仅限当前授权科室。</div></div><div class="row"><button class="btn small" data-action="refresh-knowledge-intake" ${ui.knowledgeIntakeLoading ? "disabled" : ""}>刷新</button>${hasCapability("knowledge:manage") ? `<button class="btn small primary" data-action="new-knowledge-intake">上传原始素材</button>` : ""}</div></div>
    ${ui.knowledgeIntakeError ? `<div class="risk-banner">${icon("alert",14)}<div><strong>资料列表暂时无法读取</strong><br/>请确认本地持久化服务与数据库可用后重试。<div class="row" style="margin-top:8px"><button class="btn small" data-action="refresh-knowledge-intake" ${ui.knowledgeIntakeLoading ? "disabled" : ""}>重试</button><span class="caption">错误码：${escapeHtml(ui.knowledgeIntakeError)}</span></div></div></div>` : ""}
    <div class="toolbar knowledge-intake-filters" style="padding:0 16px 12px"><div class="search-field"><span>${icon("search",15)}</span><input id="knowledge-intake-search" class="field" value="${escapeHtml(ui.knowledgeIntakeQuery)}" placeholder="搜索标题、文件名、来源或标签" /></div><select class="select" id="knowledge-intake-status">${statusOptions.map(([value,label]) => `<option value="${value}" ${ui.knowledgeIntakeStatus === value ? "selected" : ""}>${label}</option>`).join("")}</select><select class="select" id="knowledge-intake-content-type"><option value="">全部内容类型</option>${typeOptions.filter(Boolean).map((value) => `<option ${ui.knowledgeIntakeContentType === value ? "selected" : ""}>${value}</option>`).join("")}</select><select class="select" id="knowledge-intake-public-scope">${scopeOptions.map(([value,label]) => `<option value="${value}" ${ui.knowledgeIntakePublicScope === value ? "selected" : ""}>${label}</option>`).join("")}</select>${filterActive ? `<button class="btn small ghost" data-action="clear-knowledge-intake-filters">清除筛选</button>` : ""}<span class="caption">${ui.knowledgeIntakeLoading ? "正在筛选…" : `当前 ${documents.length} 条`}</span></div>
    <div class="caption" style="padding:0 16px 10px">${escapeHtml(PUBLICATION_STATUS_LEGEND)}</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>原始素材 / 版本</th><th>科室</th><th>内容类型</th><th>解析与索引</th><th>资料状态</th><th>发布状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="guardrail" style="margin:12px 16px 16px">${icon("shield",14)}候选资料仍为内部资料。编辑正文或元数据后，院方确认失效，需重新登记。正式评测、激活和回滚在下方发布包中操作，未激活内容不会进入对客检索。</div></section>`;
}

const hasCapability = capability => (ui.managementIdentity?.capabilities||[]).includes(capability);
const publicationStatus = value => ({active:'对客启用',suspended:'对客暂停（资料依据或评测已失效）',withdrawn:'已撤销',evaluated:'评测通过，尚未启用',awaiting_evaluation:'构建完成，待正式评测'}[value]||value);
async function refreshPublications(){
 try{ui.publications=await getKnowledgePublications();ui.publicationError='';}catch(e){ui.publicationError=e.message;}
 render(true);
}
function publicationPanel(){
 if(!hasCapability('knowledge:read')&&!hasCapability('evaluations:read'))return '';
 return `<section class="card padded"><div class="row between"><h3>正式发布包</h3><div>${hasCapability('knowledge:publish')?'<button class="btn primary" data-action="build-publication">构建候选包</button>':''}<button class="btn" data-action="refresh-publications">刷新</button></div></div><p>构建完成不等于对客启用。每个包固定内容、文本索引、证据关系图及规则版本；正式评测通过后才可激活。</p>${ui.publicationError?`<p role="alert">${escapeHtml(ui.publicationError)}</p>`:''}${(ui.publications||[]).map(p=>`<article class="card padded" style="margin:12px 0"><strong>${escapeHtml(p.id)}</strong><p>${escapeHtml(publicationStatus(p.status))} · ${p.chunk_count} 个文本块 · ${p.documents.length} 份资料</p><p class="caption">${p.documents.map(d=>escapeHtml(`${d.title} v${d.version} · ${d.department}`)).join('；')}</p><div class="row">${hasCapability('evaluations:run')?`<button class="btn" data-action="publication-evaluate" data-id="${escapeHtml(p.id)}">提交已签名评测</button>`:''}${hasCapability('knowledge:publish')&&!p.active&&p.status!=='withdrawn'?`<button class="btn" data-action="publication-activate" data-id="${escapeHtml(p.id)}">激活</button><button class="btn" data-action="publication-rollback" data-id="${escapeHtml(p.id)}">回滚至此包</button>`:''}${hasCapability('knowledge:withdraw')&&p.status!=='withdrawn'?`<button class="btn" data-action="publication-withdraw" data-id="${escapeHtml(p.id)}">撤销</button>`:''}</div></article>`).join('')||'<p>当前授权范围内暂无发布包。</p>'}</section>`;
}
// 回滚前必须让操作人看到“换成哪一版、影响哪些资料”，而不是只勾一个看不到内容的确认框。
function publicationRollbackComparisonBlock(target){
  const publications = Array.isArray(ui.publications) ? ui.publications : [];
  const current = publications.find((item) => item.active) || null;
  const diff = summarizePublicationRollback({ current, target });
  const documentLine = (document) => `<li>${escapeHtml(document.title)} v${Number(document.version)} · ${escapeHtml(document.department || "未标注科室")}${document.from_version ? `（原 v${Number(document.from_version)}）` : ""}</li>`;
  const documentList = (items, emptyLabel) => items.length
    ? `<ul class="caption" style="margin:6px 0 0;padding-left:18px">${items.map(documentLine).join("")}</ul>`
    : `<p class="caption" style="margin:6px 0 0">${emptyLabel}</p>`;
  const column = (title, summary, items, emptyLabel) => `<section class="card padded">
      <strong>${title}</strong>
      <p class="caption" style="margin:6px 0 0">${summary ? `${escapeHtml(summary.id)}<br/>${summary.document_count} 份资料 · ${summary.chunk_count} 个文本块` : "无"}</p>
      ${summary ? documentList(items, emptyLabel) : ""}
    </section>`;
  const departments = diff.departments.length ? diff.departments.map((item) => escapeHtml(item)).join("、") : "未标注";
  return `<section class="stack" style="margin:12px 0;gap:10px">
      <div><strong>回滚影响对比</strong><div class="caption" style="margin-top:4px">${escapeHtml(diff.impact)}</div></div>
      <div class="grid cols-2">
        ${column("当前对客启用", diff.current, diff.current_documents, "当前没有启用版本")}
        ${column(`回滚目标${diff.same_package ? "（即当前版本）" : ""}`, diff.target, diff.target_documents, "目标包没有可展示的资料")}
      </div>
      <div class="card padded">
        <strong>差异明细</strong>
        <p class="caption" style="margin:6px 0 0">新增或改版 ${diff.added.length + diff.version_changed.length} 份 · 回滚后停用 ${diff.removed.length} 份 · 内容不变 ${diff.unchanged.length} 份</p>
        ${diff.added.length ? `<p class="caption" style="margin:8px 0 0">新增资料</p>${documentList(diff.added, "")}` : ""}
        ${diff.version_changed.length ? `<p class="caption" style="margin:8px 0 0">版本变化</p>${documentList(diff.version_changed, "")}` : ""}
        ${diff.removed.length ? `<p class="caption" style="margin:8px 0 0">回滚后不再对客可见</p>${documentList(diff.removed, "")}` : ""}
        <p class="caption" style="margin:8px 0 0">涉及科室：${departments}</p>
      </div>
    </section>`;
}

function showPublicationModal(id,action){
 const pkg=(ui.publications||[]).find(p=>p.id===id);
 const candidates=(ui.knowledgeIntakeDocuments||[]).filter(d=>d.status==='release_candidate'&&d.publication_readiness?.ready);
  const content=action==='build'?candidates.map(d=>`<label style="display:block;margin:12px 0"><input type="checkbox" name="document_ids" value="${escapeHtml(d.id)}"> ${escapeHtml(d.title)} v${d.version}</label>`).join('')||'<p>暂无符合条件的候选资料，请先由内容专员补齐确认依据。</p>':action==='evaluate'?'<label>正式评测报告 JSON（含可信签名）<input type="file" name="report" accept="application/json,.json" required></label>':`${action==='rollback'?publicationRollbackComparisonBlock(pkg):''}${formField('操作原因','reason','',{required:true,type:'textarea',full:true})}<label><input type="checkbox" name="confirmed" required> 已核对目标发布包与影响范围</label>`;
 openModal({title:action==='build'?'构建不可变候选包':action==='evaluate'?'提交正式评测':`确认${{activate:'激活',rollback:'回滚',withdraw:'撤销'}[action]}`,desc:pkg?.id||'只允许纳入具有有效院方依据和公开许可的候选资料',body:`<form id="publication-form" data-package-id="${escapeHtml(id||'')}" data-operation="${action}" data-revision="${pkg?.head_revision||0}" data-request-key="${crypto.randomUUID()}">${content}</form>`,footer:'<button class="btn" data-action="modal-close">取消</button><button class="btn primary" form="publication-form" type="submit">确认提交</button>'});
}
async function refreshManagedAccounts(){
 const [accounts, member] = await Promise.allSettled([getManagementAccounts(),getMemberIntegrationStatus()]);
 ui.accountError=accounts.status==='rejected'?accounts.reason.message:'';
 ui.memberIntegrationError=member.status==='rejected'?member.reason.message:'';
 if(accounts.status==='fulfilled')ui.managedAccounts=accounts.value;
 if(member.status==='fulfilled')ui.memberIntegration=member.value;
 render(true);
}
function managedAccountsPage(){
 const config=ui.memberIntegration;
 return `<div class="page">${pageHead('系统管理','人员与岗位','按实名账号分配五岗位和科室范围，权限变更在下一次服务端请求生效。','<button class="btn primary" data-action="managed-account-new">新增账号</button><button class="btn" data-action="managed-accounts-refresh">刷新</button>')}<section class="card padded">${ui.accountError?`<p role="alert">${escapeHtml(ui.accountError)}</p>`:''}${(ui.managedAccounts||[]).map(a=>`<div class="row between" style="padding:12px"><span><strong>${escapeHtml(a.display_name)}</strong> · ${escapeHtml(a.account)} · ${escapeHtml(a.business_role)} · ${escapeHtml(a.department_ids.join('、'))} · ${a.enabled?'启用':'停用'}</span><button class="btn" data-action="managed-account-edit" data-id="${escapeHtml(a.subject)}">编辑 / 重置密码</button></div>`).join('')||'<p>尚未配置实名人员账号；当前引导管理账号不自动获得内容发布或联系方式权限。</p>'}</section><section class="card padded" style="margin-top:16px"><h3>院方客户记录查询状态</h3><p>${!config?'状态尚未读取':config.ready?'正式查询配置已就绪':config?.enabled?'配置不完整':'尚未启用正式查询'}</p><p>${escapeHtml((config?.missing||[]).join('、'))}</p><p>手机号先保存，再查询院方记录。院方已确认无需验签；结果仅表示是否已有客户记录。</p></section><section class="card padded" style="margin-top:16px"><h3>岗位权限</h3>${ROLE_CATALOG.map(r=>`<p><strong>${r.name}</strong>：${r.permissions.join('、')}；范围：${r.scope}</p>`).join('')}</section></div>`;
}
function roleWorkbenchPage(){
 const admin=hasCapability('users:manage');
 const links=admin
  ? '<a class="btn primary" href="#/administration">管理人员与岗位</a><a class="btn" href="#/integrations">查看系统接入状态</a>'
  : '<a class="btn primary" href="#/knowledge">进入知识与发布工作区</a>';
 return `<div class="page">${pageHead('总览','今日工作台',`当前岗位：${currentPhaseOneRole()}。请选择下方入口处理本岗位工作。`)}<section class="card padded"><h3>${admin?'管理工作入口':'知识与质量工作入口'}</h3><div class="row">${links}</div>${admin?`<p>已配置 ${(ui.managedAccounts||[]).length} 个实名账号。请在“组织与权限”中为各岗位配置账号，并使用对应账号登录。</p>`:''}</section></div>`;
}
function systemIntegrationsPage(){
 const config=ui.memberIntegration;
 return `<div class="page">${pageHead('系统管理','系统配置','查看当前服务端接入状态。接入密钥只保存在服务器。','<button class="btn" data-action="managed-accounts-refresh">刷新接入状态</button>')}<section class="card padded"><h3>院方客户记录查询</h3><p>${!config?'状态尚未读取':config.ready?'已启用，配置完整':config.enabled?'配置不完整':'尚未启用'}</p>${ui.memberIntegrationError?`<p role="alert">${escapeHtml(ui.memberIntegrationError)}</p>`:''}<p>无需验签。查询结果为 true 表示已有客户记录，false 表示未找到记录。</p><p>手机号格式正确后先保存，查询失败不影响留资；手机号归属由销售回拨确认。</p><p>${escapeHtml((config?.missing||[]).join('、'))}</p></section><section class="card padded" style="margin-top:16px"><h3>账号与权限配置</h3><p>实际人员与岗位请在组织与权限中维护。</p><a class="btn" href="#/administration">进入组织与权限</a></section></div>`;
}
function showManagedAccountModal(subject){
 const a=(ui.managedAccounts||[]).find(a=>a.subject===subject);
 openModal({title:a?'编辑账号与权限':'新增实名账号',desc:'使用账号密码登录受控外测；正式环境用 OIDC subject 绑定身份。密码不回显，留空保持原密码。',body:`<form id="managed-account-form" data-subject="${escapeHtml(a?.subject||'')}" data-version="${a?.version||0}"><div class="form-grid">${formField('姓名','display_name',a?.display_name||'',{required:true})}${formField('登录账号','account',a?.account||'',{required:true})}${!a?formField('OIDC subject（可选）','oidc_subject',''):''}${formField('岗位','role',a?.business_role||'售前顾问',{type:'select',items:ROLE_CATALOG.map(r=>r.name)})}${formField('授权科室（逗号分隔，全院填 *）','departments',a?.department_ids?.join('，')||'',{required:true})}${formField('状态','enabled',a?.enabled===false?'停用':'启用',{type:'select',items:['启用','停用']})}${a?`<label>在办事项接收人（停用或调整岗位时选择）<select class="select" name="transfer_to_subject"><option value="">暂不移交</option>${(ui.managedAccounts||[]).filter(r=>r.enabled&&r.business_role==='售前顾问'&&r.subject!==a.subject).map(r=>`<option value="${escapeHtml(r.subject)}">${escapeHtml(r.display_name)} · ${escapeHtml(r.account)}</option>`).join('')}</select></label>`:''}<label>新密码（至少8字符，可留空绑定企业身份）<input class="field" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256"></label></div></form>`,footer:'<button class="btn" data-action="modal-close">取消</button><button class="btn primary" form="managed-account-form" type="submit">保存权限</button>'});
}

function qualityFeedbackPanel(){
 return `<section class="card padded"><div class="row between"><h3>脱敏反馈与质量复核</h3><button class="btn" data-action="refresh-bad-cases">刷新反馈</button></div><p>未归属科室的记录仅对全院范围质检开放。</p>${ui.badCasesError?`<p role="alert">${escapeHtml(ui.badCasesError)}</p>`:''}${ui.badCases.map(f=>`<div class="row between"><span>${escapeHtml(f.id)} · ${escapeHtml(f.status)}</span><button class="btn" data-action="view-bad-case" data-id="${escapeHtml(f.id)}">查看脱敏记录</button></div>`).join('')||'<p>暂无可显示的反馈，请刷新查看。</p>'}</section>`;
}

function productionKnowledgeGovernancePage() {
  const actions = `${knowledgeIntakeEnabled && hasCapability("knowledge:manage") ? `<button class="btn primary" data-action="new-knowledge-intake">${icon("plus",15)}录入资料</button>` : ""}`;
  return `<div class="page">${pageHead("知识库与图谱", "知识与合规", "资料解析后保存为内部草稿；补齐来源与院方确认后准备候选，完成正式发布才能用于对客问答。", actions)}${knowledgeIntakePanel()}${publicationPanel()}${hasCapability("feedback:manage") ? qualityFeedbackPanel() : ""}</div>`;
}

function knowledgePage() {
  const query = ui.knowledgeQuery.trim().toLowerCase();
  const projectItems = store.state.knowledge.filter((item) => item.sourceId);
  const canonicalProjects = new Set(projectItems.map((item) => item.project)).size;
  const parts = [...new Set(projectItems.flatMap((item) => item.parts || []))];
  const riskCounts = Object.fromEntries(["H1","H2","H3"].map((risk) => [risk, projectItems.filter((item) => item.risk === risk).length]));
  const auditedComplianceBlocks = (store.state.audit || []).filter((item) => /拦截|医疗边界|合规/.test(`${item.actor || ""} ${item.action || ""} ${item.result || ""}`)).length;
  const searchableText = (item) => [
    item.title,item.project,item.layer,item.status,item.owner,item.sourceTitle,item.brandOrModel,
    ...(item.parts || []),...(item.efficacyLabels || []),...(item.cardTags || []),
    ...(item.sections || []).flatMap((section) => [section.title,section.content])
  ].join(" ").toLowerCase();
  const items = store.state.knowledge.filter((item) => {
    const matchesQuery = !query || searchableText(item).includes(query);
    const matchesRisk = ui.knowledgeRisk === "全部风险" || item.risk === ui.knowledgeRisk;
    const matchesPart = ui.knowledgePart === "全部部位" || (item.parts || []).includes(ui.knowledgePart);
    return matchesQuery && matchesRisk && matchesPart;
  });
  const totalPages = Math.max(1, Math.ceil(items.length / ui.knowledgePageSize));
  ui.knowledgePage = Math.min(Math.max(1, ui.knowledgePage), totalPages);
  const pageStartIndex = (ui.knowledgePage - 1) * ui.knowledgePageSize;
  const pageItems = items.slice(pageStartIndex, pageStartIndex + ui.knowledgePageSize);
  const pageStart = items.length ? pageStartIndex + 1 : 0;
  const pageEnd = Math.min(pageStartIndex + ui.knowledgePageSize, items.length);
  const pagination = items.length ? `<div class="pagination-bar">
    <div class="pagination-summary"><span>显示 <strong>${pageStart}–${pageEnd}</strong> / 共 ${items.length} 条</span><label class="page-size-control">每页<select class="select" id="knowledge-page-size" aria-label="知识库每页条数">${[10,20,30].map((size) => `<option value="${size}" ${ui.knowledgePageSize === size ? "selected" : ""}>${size}</option>`).join("")}</select>条</label></div>
    <nav class="pagination-controls" aria-label="知识库分页">
      <button class="page-btn page-nav prev" data-action="knowledge-page" data-id="${ui.knowledgePage - 1}" aria-label="上一页" ${ui.knowledgePage === 1 ? "disabled" : ""}>${icon("chevron",14)}</button>
      ${paginationItems(ui.knowledgePage,totalPages).map((page) => page === "ellipsis" ? `<span class="page-ellipsis" aria-hidden="true">…</span>` : `<button class="page-btn ${page === ui.knowledgePage ? "active" : ""}" data-action="knowledge-page" data-id="${page}" ${page === ui.knowledgePage ? `aria-current="page"` : ""}>${page}</button>`).join("")}
      <button class="page-btn page-nav" data-action="knowledge-page" data-id="${ui.knowledgePage + 1}" aria-label="下一页" ${ui.knowledgePage === totalPages ? "disabled" : ""}>${icon("chevron",14)}</button>
    </nav>
  </div>` : "";
  const governanceSelected = ui.knowledgeTab === "准入与发布";
  const knowledgeActions = knowledgeIntakeEnabled
    ? `<button class="btn" data-action="rule-test">${icon("shield",15)}回答安全检查</button><button class="btn primary" data-action="new-knowledge-intake">${icon("plus",15)}录入资料</button>`
    : `<button class="btn" data-action="rule-test">${icon("shield",15)}回答安全检查</button><button class="btn primary" data-action="new-knowledge">${icon("plus",15)}新增知识</button>`;
  return `<div class="page">${pageHead("知识与合规", "知识与合规", "集中管理可用于客户咨询的项目知识、内部草稿维护进度和风险规则。", knowledgeActions)}
    ${knowledgeIntakePanel()}
    <div class="knowledge-summary"><section class="card padded"><div class="card-title">完整项目知识已接入</div><div class="card-subtitle">${projectItems.length}张项目卡片，覆盖${canonicalProjects}个标准项目；介绍、原理、功效、流程、效果与注意事项均已保留。</div><div class="risk-distribution" style="margin:17px 0 8px"><span style="width:${projectItems.length ? riskCounts.H3 / projectItems.length * 100 : 0}%"></span><span style="width:${projectItems.length ? riskCounts.H2 / projectItems.length * 100 : 0}%"></span><span style="width:${projectItems.length ? riskCounts.H1 / projectItems.length * 100 : 0}%"></span></div><div class="row between caption"><span>高风险·手术类 ${riskCounts.H3}</span><span>中风险·微创/注射 ${riskCounts.H2}</span><span>一般风险·光电/皮肤 ${riskCounts.H1}</span></div></section>${metric("项目知识", String(projectItems.length), `${canonicalProjects}个标准项目`, "database")}${metric("待解析资料", String((ui.knowledgeIntakeDocuments || []).filter((item) => item.status === "parsing_pending").length), "解析后仍为内部草稿", "clock")}${metric("可追溯合规动作", String(auditedComplianceBlocks), "以当前审计记录为准", "alert")}</div>
    <section class="card"><div class="card-head knowledge-toolbar"><div class="segmented">${["知识库","准入与发布","合规规则","回答审计","评测中心"].map((tab) => `<button class="tab-btn ${ui.knowledgeTab === tab ? "active" : ""}" data-action="knowledge-tab" data-id="${tab}">${tab === "评测中心" ? "回答质量检查" : tab === "回答审计" ? "回答追溯" : tab}</button>`).join("")}</div>${governanceSelected ? "" : `<div class="knowledge-filters"><select class="select" id="knowledge-risk">${["全部风险","H1","H2","H3"].map((risk) => `<option value="${risk}" ${ui.knowledgeRisk === risk ? "selected" : ""}>${risk === "全部风险" ? risk : knowledgeRiskLabel(risk)}</option>`).join("")}</select><select class="select" id="knowledge-part">${["全部部位",...parts].map((part) => `<option ${ui.knowledgePart === part ? "selected" : ""}>${part}</option>`).join("")}</select><div class="search-field">${icon("search",15)}<input id="knowledge-search" class="field" value="${escapeHtml(ui.knowledgeQuery)}" placeholder="搜索项目、功效、部位或正文…"/></div></div>`}</div>
      ${ui.knowledgeTab === "知识库" ? `<div class="knowledge-result-meta"><span>共 ${items.length} 条知识</span><span>项目卡片 ${items.filter((item) => item.sourceId).length} 条</span><span>第 ${ui.knowledgePage} / ${totalPages} 页</span></div><div>${pageItems.map(knowledgeRow).join("") || empty("没有匹配知识", "调整搜索或筛选条件")}</div>${pagination}` : governanceSelected ? knowledgeGovernancePage() : knowledgeSubPage()}
    </section>
  </div>`;
}

function knowledgeRow(item) {
  const effects = (item.efficacyLabels || []).slice(0,3);
  return `<div class="knowledge-item"><div><button class="link knowledge-title" data-entity="knowledge-item" data-id="${item.id}">${escapeHtml(item.title)}</button><div class="knowledge-excerpt">${escapeHtml(item.excerpt)}</div>${effects.length ? `<div class="knowledge-tags">${effects.map((effect) => badge(effect,"outline")).join("")}</div>` : ""}</div><div>${badge(knowledgeLayerLabel(item.layer),item.layer.startsWith("L4") ? "danger" : item.layer.startsWith("L2") ? "success" : "")}</div><div>${badge(item.status)}</div><div><strong>${escapeHtml(item.project)}</strong><div class="customer-meta">${(item.parts || []).join("/") || "通用"} · ${knowledgeRiskLabel(item.risk)}</div></div><div><strong>${item.version}</strong><div class="customer-meta">${item.owner} · ${relativeTime(item.updatedAt)}</div></div><div class="row"><button class="btn small ghost" data-entity="knowledge-item" data-id="${item.id}">详情</button>${item.status === "已发布" ? `<button class="btn small danger" data-action="unpublish-knowledge" data-id="${item.id}">下架</button>` : ""}</div></div>`;
}

function knowledgeSubPage() {
  if (ui.knowledgeTab === "合规规则") return `<div class="card-body"><table class="data-table"><thead><tr><th>规则</th><th>处理要求</th><th>动作</th><th>运行记录</th><th>状态</th></tr></thead><tbody>${[["个体适用性/禁忌判断","强制人工处理","强制转人工"],["异常反应与用药","强制人工处理","升级售后/医务"],["绝对化效果承诺","强制拦截","拦截并重写"],["照片授权失效","强制拦截","停止展示"],["营销触达频控","受限执行","延期/退出旅程"]].map((row) => `<tr><td>${row[0]}</td><td>${badge(row[1],"danger")}</td><td>${row[2]}</td><td>以接口运行审计为准</td><td>${badge("已配置","success")}</td></tr>`).join("")}</tbody></table></div>`;
  if (ui.knowledgeTab === "回答审计") return `<div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>执行者</th><th>动作</th><th>对象</th><th>结果</th><th>风险</th></tr></thead><tbody>${store.state.audit.map((item) => `<tr><td>${formatDate(item.at)}</td><td>${item.actor}</td><td>${item.action}</td><td>${item.object}</td><td>${item.result}</td><td>${badge(item.severity,item.severity === "高" ? "danger" : item.severity === "中" ? "warning" : "success")}</td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="card-body"><div class="grid cols-3">${[["医疗边界检查","强制≥98%"],["宣传表达检查","强制≥97%"],["知识正确性检查","目标≥95%"]].map(([name,gate]) => `<div class="card padded"><div class="card-title">${name}</div><div class="metric-value">—</div><div class="caption">生产评测流水线尚未回填结果 · 门槛 ${gate}</div></div>`).join("")}</div><div class="guardrail" style="margin-top:16px">${icon("shield",14)}如需手工校验一条待发送内容，请进入 AI 员工 API开放平台，选择合规守门员执行真实检查。</div></div>`;
}

function analyticsPage() {
  const metrics = managementOverviewMetrics();
  const channelRows = [...metrics.customers.reduce((map, customer) => {
    const key = customer.latestChannel || customer.firstChannel || customer.source || "未分类";
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const projectRows = [...metrics.customers.flatMap((customer) => customer.interests || []).reduce((map, interest) => {
    const key = interest.projectRef?.name || interest.name || "待识别";
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const stageRows = [["售前", metrics.countStage("售前")], ["售中", metrics.countStage("售中")], ["售后", metrics.countStage("售后")]];
  const total = metrics.customers.length;
  return `<div class="page">${pageHead("经营分析", "数据分析", "仅统计当前系统内已建档的客户、会话和任务。交易、到院和外部渠道数据尚未接入，不以演示数字替代。", `<select class="select" id="analytics-range">${["近7天","近30天","本季度"].map((range) => `<option ${ui.analyticsRange === range ? "selected" : ""}>${range}</option>`).join("")}</select><button class="btn" data-action="export-report">${icon("download",15)}导出经营报告</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("已建档客户", String(total), "统一客户档案", "message")}${metric("当前会话", String(metrics.conversations.length), "会话模块实时口径", "users")}${metric("到院登记待跟进", String(metrics.openTasks.filter((item) => /预约/.test(item.title || "")).length), "任务模块口径", "calendar")}${metric("已完成任务", String(metrics.tasks.filter((item) => item.status === "已完成").length), "当前系统任务记录", "chart")}</div>
    <div class="grid analytics-grid"><div class="stack">${card("客户阶段分布", `<div class="bar-chart">${stageRows.map(([name,count]) => `<div class="bar-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${total ? count / total * 100 : 0}%"></div></div><strong>${count}人</strong></div>`).join("")}</div>`, { subtitle:"当前系统已建档客户" })}${card("项目兴趣", projectRows.length ? `<div class="bar-chart">${projectRows.slice(0, 8).map(([name,count]) => `<div class="bar-row"><span>${escapeHtml(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${total ? count / total * 100 : 0}%"></div></div><strong>${count}人</strong></div>`).join("")}</div>` : empty("暂无项目兴趣数据", "客户表达项目需求后会显示"), { subtitle:"按统一项目字典归一" })}</div><div class="stack">${card("客户阶段漏斗", `<div class="funnel">${[["已建档", total], ...stageRows].map(([label,value]) => `<button class="funnel-row" style="border:0;background:transparent;text-align:left;cursor:pointer" data-action="analytics-drill" data-id="${label}"><span>${label}</span><div class="funnel-track"><div class="funnel-fill" style="width:${total ? value / total * 100 : 0}%">${value}</div></div><strong>${total ? Math.round(value / total * 100) : 0}%</strong></button>`).join("")}</div>`, { subtitle:"点击阶段下钻客户清单" })}${card("AI与人工协作", `<div class="profile-list">${[["AI参与会话",metrics.conversations.filter((item) => String(item.mode || "").includes("AI")).length],["待人工接管",metrics.conversations.filter((item) => ["待人工","人工处理中"].includes(item.status)).length],["待人工确认任务",metrics.openTasks.filter((item) => ["AI转人工","AI审批"].includes(item.type)).length],["已配置AI员工",store.state.agents.length]].map(([key,value]) => `<div class="profile-row" style="grid-template-columns:1fr auto"><span class="profile-key">${key}<small style="display:block;margin-top:3px">当前系统可追溯记录</small></span><strong>${value}</strong></div>`).join("")}</div>`, { action: `<button class="link" data-nav="agents">查看AI员工</button>` })}${card("经营异常洞察", metrics.overdueTasks.length ? `<div class="risk-banner">${icon("alert",15)}当前有 ${metrics.overdueTasks.length} 项任务超时或已超时，需要负责人优先处理。</div><button class="btn small primary" style="margin-top:12px" data-action="create-insight-task">生成改进任务</button>` : `<div class="risk-banner">${icon("shield",15)}当前没有超时任务。系统仍会持续校验任务、客户和会话的关联关系。</div>`)}</div></div>
    <section class="card" style="margin-top:16px"><div class="card-head"><div><div class="card-title">渠道明细</div><div class="card-subtitle">仅按当前客户档案中的最近服务渠道统计</div></div></div>${channelRows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>渠道</th><th>客户数</th><th>占当前客户</th><th>建议</th></tr></thead><tbody>${channelRows.map(([name,count]) => `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${count}</td><td>${total ? Math.round(count / total * 100) : 0}%</td><td><button class="link" data-action="analytics-drill" data-id="${escapeHtml(name)}">查看客户</button></td></tr>`).join("")}</tbody></table></div>` : empty("暂无渠道数据", "客户建档后会显示来源渠道")}</section>
  </div>`;
}

function integrationsPage() {
  const connectors = store.state.connectors || [];
  const customerCount = (store.state.customers || []).length;
  const conversationCount = (store.state.conversations || []).length;
  const pendingConnectors = connectors.filter((item) => item.status !== "已接入").length;
  return `<div class="page">${pageHead("系统配置", "本地数据服务", "一期以本地独立系统运行。客户、会话、任务、旅程和后台配置均由本地持久化服务保存；未授权接入外部系统时，不显示虚构同步数据。", `<button class="btn" data-action="reload-management-data">${icon("refresh",15)}刷新数据</button><button class="btn primary" data-action="new-connector">${icon("plus",15)}登记对接预留</button>`)}
    <div class="grid cols-4" style="margin-bottom:16px">${metric("本地客户档案", String(customerCount), "已保存的客户记录", "users")}${metric("本地会话", String(conversationCount), "已保存的会话记录", "message")}${metric("对接预留", String(connectors.length), "尚未建立外部数据连接", "database")}${metric("待配置预留", String(pendingConnectors), "无凭据，不读写外部数据", "shield")}</div>
    ${connectors.length ? `<div class="connector-grid">${connectors.map((connector) => `<article class="card connector-card"><div class="row"><div class="connector-icon">${icon(connector.icon || "database",20)}</div><div><h3 style="margin:0 0 4px;font-size:15px">${escapeHtml(connector.name)}</h3><div class="caption">${escapeHtml(connector.vendor || "未填写系统")} · ${escapeHtml(connector.direction || "读取")}</div></div><span class="spacer"></span>${badge(connector.status || "待接入")}</div><div class="connector-stats"><div class="mini-stat"><div class="mini-stat-label">业务用途</div><div class="mini-stat-value">${escapeHtml(connector.purpose || "待补充")}</div></div><div class="mini-stat"><div class="mini-stat-label">已配置凭据</div><div class="mini-stat-value">否</div></div><div class="mini-stat"><div class="mini-stat-label">可读写外部数据</div><div class="mini-stat-value">否</div></div><div class="mini-stat"><div class="mini-stat-label">最近检查</div><div class="mini-stat-value">${connector.lastCheckedAt ? relativeTime(connector.lastCheckedAt) : "未检查"}</div></div></div><div class="row"><button class="btn small" data-action="test-connector" data-id="${connector.id}">检查配置</button><span class="spacer"></span><button class="btn icon-only small ghost" data-action="connector-more" data-id="${connector.id}">${icon("more",15)}</button></div></article>`).join("")}</div>` : empty("暂无对接预留", "当前无需外部系统接入；如后续需要 CRM、预约或企业微信，请先在此登记用途与数据方向。")}
    <div class="risk-banner" style="margin-top:16px">${icon("shield",16)}本页的“对接预留”仅保存需求与治理信息，不保存密钥，也不会连接、同步或修改任何外部系统数据。</div>
  </div>`;
}

function settingsSubPage() {
  const tabs = ["连接器","字段映射","身份规则","组织与人员","阶段与项目","权限与审计","演示设置"];
  const content = {
    "字段映射": `<div class="card-head"><div><div class="card-title">统一字段映射</div><div class="card-subtitle">外部系统字段只映射，不改变其交易职责</div></div><button class="btn primary" data-action="new-mapping">新增映射</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>统一字段</th><th>CRM</th><th>预约</th><th>收银</th><th>权威源</th><th>冲突策略</th></tr></thead><tbody>${[["customer_id","customer_no","customer_id","member_id","客户360","强标识合并"],["mobile_hash","mobile","mobile","mobile","CRM","最新有效值"],["lifecycle_stage","stage","appointment_status","payment_status","规则引擎","事件重算"],["project_code","intent_project","project_code","item_code","项目字典","别名归一"],["owner_id","consultant_id","staff_id","operator_id","CRM","人工优先"]].map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
    "身份规则": `<div class="card-head"><div><div class="card-title">统一身份与合并规则</div><div class="card-subtitle">强标识自动合并，弱标识只生成候选并人工复核</div></div></div><div class="card-body"><div class="form-grid">${formField("强标识","strong","手机号哈希、企微external_userid、CRM客户号")}${formField("弱标识","weak","姓名+城市+设备ID+时间窗口")}${formField("自动合并阈值","threshold","100% 强标识一致")}${formField("候选复核阈值","review","70–99% 相似度")}</div><div class="divider"></div><div class="risk-banner">${icon("alert",15)}医疗记录、支付记录和投诉记录不能仅凭姓名自动合并；合并与拆分必须完整审计并支持回滚。</div></div>`,
    "组织与人员": `<div class="card-head"><div><div class="card-title">组织与人员</div><div class="card-subtitle">集团 / 院区 / 门店 / 部门 / 团队 / 角色 / 班次</div></div><button class="btn primary" data-action="new-member">新增成员</button></div><div class="card-body"><div class="board">${[["在线咨询组","周妍、方琳","AI获客顾问、AI邀约专员"],["到院咨询组","陈露、赵伊","AI接待助手"],["售后与医务","顾薇、医务值班","AI售后关怀、合规守门员"]].map(([name,people,agents]) => `<div class="board-column"><div class="board-head"><strong>${name}</strong>${badge("正常","success")}</div><div class="customer-board-card"><div class="caption">人工成员</div><strong style="display:block;margin-top:5px">${people}</strong></div><div class="customer-board-card"><div class="caption">协作AI员工</div><strong style="display:block;margin-top:5px">${agents}</strong></div></div>`).join("")}</div></div>`,
    "阶段与项目": `<div class="card-head"><div><div class="card-title">生命周期与项目字典</div><div class="card-subtitle">统一维护时代之美的客户阶段、跟进环节和医美项目名称</div></div><button class="btn primary" data-action="save-settings">保存配置</button></div><div class="card-body"><div class="grid cols-3">${Object.entries(stageSteps).map(([stage,steps]) => `<div class="card padded"><div class="row between"><strong>${stage}</strong>${badge(`${steps.length}个环节`,stage)}</div><div class="stack" style="margin-top:12px">${steps.map((step,index) => `<div class="row"><span class="node-dot">${index+1}</span><span>${step}</span></div>`).join("")}</div></div>`).join("")}</div><div class="divider"></div><div class="tag-list">${["热玛吉","线雕","拉皮/微拉美","提眉","注射塑颜","面部轮廓","眼部整形","鼻部整形","胸部整形","脂肪管理"].map((item) => badge(item,"outline")).join("")}</div></div>`,
    "权限与审计": `<div class="card-head"><div><div class="card-title">角色与敏感数据权限</div><div class="card-subtitle">按岗位、组织和数据类型控制可见范围</div></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>角色</th><th>客户范围</th><th>照片</th><th>会话原文</th><th>交易明细</th><th>策略发布</th></tr></thead><tbody>${[["管理者","全院聚合/授权下钻","受控","受控","受控","审批"],["在线咨询","本人/团队","缩略图","可见","不可见","不可"],["到院咨询师","本人客户","授权可见","摘要","项目状态","不可"],["售后客服","售后归属","授权可见","服务会话","项目引用","不可"],["医务/合规","风险事件","按需","审计可见","必要引用","规则/知识审批"]].map((row) => `<tr>${row.map((cell,index) => `<td>${index ? cell : `<strong>${cell}</strong>`}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
    "演示设置": `<div class="card-head"><div><div class="card-title">数据服务说明</div><div class="card-subtitle">业务数据由服务端本地持久化服务保存，不使用浏览器样例缓存。</div></div></div><div class="card-body"><div class="risk-banner">${icon("shield",15)}为保护已录入的运营资料，系统不提供前端批量清空或恢复样例数据的操作。</div></div>`
  }[ui.settingsTab];
  return `<div class="page">${pageHead("系统设置", "集成与设置", "统一配置组织、客户身份、业务阶段、项目和权限。", `<button class="btn" data-action="settings-tab" data-id="连接器">返回连接器</button>`)}<div class="grid settings-layout"><aside class="card settings-menu">${tabs.map((tab) => `<button class="${ui.settingsTab === tab ? "active" : ""}" data-action="settings-tab" data-id="${tab}">${icon(tab === "字段映射" ? "database" : tab === "身份规则" ? "users" : tab === "权限与审计" ? "shield" : "settings",15)}${tab}</button>`).join("")}</aside><section class="card">${content || empty("设置页准备中", "请选择左侧设置项")}</section></div></div>`;
}

function currentPage() {
  if(!ui.managementIdentity)return `<div class="page"><p role="alert">${escapeHtml(ui.identityError||"正在验证管理身份…")}</p></div>`;
  const businessRole=roleCatalogEntry(ui.managementIdentity.role)?.key;
  if(businessRole==='superadministrator'&&routeInfo().route==='administration')return managedAccountsPage();
  if(businessRole==='superadministrator'&&routeInfo().route==='knowledge')return productionKnowledgeGovernancePage();
  if(businessRole==="administrator"){
    const route=routeInfo().route;
    return route==='administration'?managedAccountsPage():route==='integrations'?systemIntegrationsPage():roleWorkbenchPage();
  }
  if(["content","publisher","quality"].includes(businessRole))return routeInfo().route==='knowledge'?productionKnowledgeGovernancePage():roleWorkbenchPage();
  if (!handoverOnlyMode && !ui.managementDataReady) {
    const message = ui.managementDataError
      ? "本地持久化服务暂时不可用。为避免展示旧样例或写入浏览器缓存，后台没有加载任何业务记录。"
      : "正在从本地持久化服务读取知识导入结果与运营记录。";
    const action = ui.managementDataError
      ? `<button class="btn primary" data-action="reload-management-data">${icon("refresh",15)}重新连接</button>`
      : "";
    return `<div class="page">${pageHead("系统初始化", "正在加载管理数据", message, action)}<section class="card">${empty(ui.managementDataError ? "数据服务未连接" : "正在加载", ui.managementDataError || "加载完成后将显示真实的客户、会话、配置与审计记录。")}</section></div>`;
  }
  if (handoverOnlyMode) return routeInfo().route === "knowledge" && (knowledgeGovernanceEnabled || knowledgeIntakeEnabled)
    ? productionKnowledgeGovernancePage()
    : workbenchPage();
  const { route, id, resourceId } = routeInfo();
  if (route === "catalog" && id === "prices") {
    // Keep old bookmarks usable after pricing became a product field.
    history.replaceState(null, "", "#/catalog");
    return renderSubpage("catalog", "overview");
  }
  if (route === "customer") return customer360Page(id);
  if (route === "conversation" && isPresalesWorkspace()) {
    if (!store.conversation(id)) return `<div class="page">${pageHead("会话与接待", "会话不可用", "该会话不在当前售前人员可处理的接待队列中。")}<section class="card">${empty("未找到可接待会话", "请从会话收件箱选择已进入聊天的客户。")}</section></div>`;
    ui.conversationId = id;
    return conversationsPage();
  }
  if (route === "journey") return journeyCanvasPage(id);
  if (["task", "conversation", "journey", "agent", "physician", "knowledge-item", "connector", "segment"].includes(route)) return renderEntityPage(route, id);
  if (route === "physicians" && id === "avatar") {
    if (!resourceId) return physicianAvatarPickerPage();
    const physician = store.physician(resourceId);
    return physician ? physicianAvatarStudioPage(physician) : physicianAvatarMissingPage(resourceId);
  }
  if (id && moduleNavConfig[route]?.some(([key]) => key === id)) {
    return renderSubpage(route, id, {
      badCases:ui.badCases,
      badCasesLoading:ui.badCasesLoading,
      badCasesError:ui.badCasesError
    });
  }
  const content = ({
    workbench: workbenchPage,
    customers: customersPage,
    conversations: conversationsPage,
    journeys: journeysPage,
    agents: agentsPage,
    physicians: physiciansPage,
    knowledge: knowledgePage,
    catalog: () => renderSubpage("catalog", "overview"),
    analytics: analyticsPage,
    integrations: integrationsPage,
    administration: () => renderSubpage("administration", "overview")
  }[route] || workbenchPage)();
  // 产品与价格、系统管理的概览页复用二级页面渲染器，页面自身已包含
  // 二级导航，避免壳层再次插入一份重复菜单。
  if (["catalog", "administration"].includes(route)) return content;
  return content.replace("</header>", `</header>${moduleSubnav(route, "overview")}`);
}

async function hydrateLlmRuntime() {
  const runtimeValue = document.querySelector("#llm-runtime-value");
  const modelName = document.querySelector("#llm-model-name");
  if (!runtimeValue && !modelName) return;
  const runtimeDetail = document.querySelector("#llm-runtime-detail");
  const providerName = document.querySelector("#llm-provider-name");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    const active = response.ok && health.llm?.enabled && health.llm?.configured;
    if (runtimeValue) runtimeValue.textContent = active ? "在线" : "规则";
    if (runtimeDetail) runtimeDetail.textContent = active ? "LLM + 确定性门禁" : "本地规则降级运行";
    if (modelName) modelName.textContent = health.llm?.model || "未配置";
    if (providerName) providerName.textContent = health.llm?.provider || "local_rule_runtime";
  } catch {
    if (runtimeValue) runtimeValue.textContent = "离线";
    if (runtimeDetail) runtimeDetail.textContent = "无法读取模型状态";
    if (modelName) modelName.textContent = "未连接";
  }
}

const avatarApiHeaders = { Accept:"application/json", "X-Huamei-User-Id":"admin-xuning" };

function scheduleAvatarUiPoll() {
  const physicianId = routeAvatarPhysician()?.id;
  const busy = Boolean(physicianId && (ui.avatarMutationCounts[physicianId] || (ui.avatarLoading && ui.avatarLoadingPhysicianId === physicianId) || ui.avatarPollingPhysicianId === physicianId));
  const shouldPoll = !busy && document.visibilityState !== "hidden" && physicianId && ui.avatarJobsPhysicianId === physicianId && ui.avatarJobs.some((job) => job.physicianId === physicianId && ["queued","processing"].includes(job.status));
  if (!shouldPoll) {
    clearTimeout(ui.avatarPollTimer);
    ui.avatarPollTimer = null;
    return;
  }
  if (ui.avatarPollTimer) return;
  const configuredInterval = Number(ui.avatarRuntime?.polling?.intervalMs);
  const interval = Number.isFinite(configuredInterval) && configuredInterval >= 10000 ? configuredInterval : 10000;
  ui.avatarPollTimer = setTimeout(() => {
    ui.avatarPollTimer = null;
    if (avatarScopeMatches(physicianId)) hydrateAvatarStudio(true, { background:true });
  }, interval);
}

async function hydrateAvatarStudio(force = false, { background = false } = {}) {
  const physician = routeAvatarPhysician();
  if (!physician) return;
  syncAvatarStudioScope();
  const physicianId = physician.id;
  if (ui.avatarMutationCounts[physicianId] || (ui.avatarLoading && ui.avatarLoadingPhysicianId === physicianId) || ui.avatarPollingPhysicianId === physicianId) return;
  if (!force && ui.avatarJobsPhysicianId === physicianId && Date.now() - ui.avatarHydratedAt < 5000) { scheduleAvatarUiPoll(); return; }
  const requestToken = ++ui.avatarRequestToken;
  const scopeEpoch = ui.avatarScopeEpoch;
  if (background) {
    clearTimeout(ui.avatarPollTimer);
    ui.avatarPollTimer = null;
    ui.avatarPollingPhysicianId = physicianId;
    ui.avatarPollingRequestToken = requestToken;
  } else {
    ui.avatarLoading = true;
    ui.avatarLoadingPhysicianId = physicianId;
    ui.avatarLoadError = "";
    patchAvatarLoadingDom(physician, true);
  }
  try {
    const statusRequest = background && ui.avatarRuntime ? Promise.resolve(null) : fetch("/api/local/physician-avatar/status", { headers:avatarApiHeaders, cache:"no-store" });
    const [statusResponse, jobsResponse] = await Promise.all([
      statusRequest,
      fetch(`/api/local/physician-avatar/jobs?physician_id=${encodeURIComponent(physicianId)}&limit=60`, { headers:avatarApiHeaders, cache:"no-store" })
    ]);
    const [statusBody, jobsBody] = await Promise.all([statusResponse ? statusResponse.json() : Promise.resolve({ data:ui.avatarRuntime }),jobsResponse.json()]);
    if (statusResponse && !statusResponse.ok) throw new Error(avatarBusinessError(statusBody.error, "视频生成服务暂时不可用，请稍后重试。"));
    if (!jobsResponse.ok) throw new Error(avatarBusinessError(jobsBody.error, "暂时无法读取任务与作品，请稍后重试。"));
    if (requestToken !== ui.avatarRequestToken || !avatarScopeMatches(physicianId, scopeEpoch)) return;
    const previousJobs = ui.avatarJobsPhysicianId === physicianId ? [...ui.avatarJobs] : [];
    const currentById = new Map(previousJobs.map((job) => [job.generationJobId, job]));
    const nextJobs = (jobsBody.data || [])
      .filter((job) => job.physicianId === physicianId)
      .map((job) => mergeAvatarJobSnapshot(currentById.get(job.generationJobId), job));
    ui.avatarRuntime = statusBody.data;
    ui.avatarJobs = nextJobs;
    ui.avatarJobsPhysicianId = physicianId;
    ui.avatarLoadError = "";
    ui.avatarHydratedAt = Date.now();
    patchAvatarRuntimeDom(physicianId);
    patchAvatarStudioDom(physician, previousJobs, nextJobs);
    if (background) notifyAvatarJobTransitions(previousJobs, nextJobs);
  } catch (error) {
    if (!background && requestToken === ui.avatarRequestToken && avatarScopeMatches(physicianId, scopeEpoch)) {
      ui.avatarLoadError = avatarBusinessError(error, "视频生成服务暂时不可用，请稍后重试。");
      patchAvatarLoadErrorDom(physician);
      toast(ui.avatarLoadError, "danger");
    }
  } finally {
    if (background && ui.avatarPollingPhysicianId === physicianId && ui.avatarPollingRequestToken === requestToken) {
      ui.avatarPollingPhysicianId = "";
      ui.avatarPollingRequestToken = 0;
    }
    if (!background && requestToken === ui.avatarRequestToken && avatarScopeMatches(physicianId, scopeEpoch)) {
      ui.avatarLoading = false;
      ui.avatarLoadingPhysicianId = "";
      patchAvatarLoadingDom(physician, false);
    }
    if (avatarScopeMatches(physicianId, scopeEpoch)) {
      scheduleAvatarUiPoll();
    }
  }
}

async function submitPhysicianAvatar(form) {
  const physician = routeAvatarPhysician();
  if (!physician) return toast("请先选择要创建AI分身视频的医师。", "warning");
  const submittedPhysicianId = physician.id;
  const referenceFileId = physicianAvatarReferenceFileId(submittedPhysicianId);
  if (!referenceFileId) return toast("当前医师尚未配置可用的生成参考形象，请先完善医师素材。", "warning");
  const scopeEpoch = ui.avatarScopeEpoch;
  const submitToken = ++ui.avatarSubmitToken;
  const data = Object.fromEntries(new FormData(form));
  const payload = {
    physicianId:submittedPhysicianId, title:data.title, script:data.script, voiceId:data.voiceId,
    resolution:data.resolution, duration:Number(data.duration), ratio:data.ratio, mode:data.mode,
    referenceFileId,
    consentConfirmed:data.consentConfirmed === "true", generativeDisclosureConfirmed:data.generativeDisclosureConfirmed === "true"
  };
  ui.avatarSubmittingPhysicianId = submittedPhysicianId;
  const previousJobs = [...ui.avatarJobs];
  beginAvatarMutation(submittedPhysicianId);
  try {
    const response = await fetch("/api/local/physician-avatar/jobs", {
      method:"POST",
      headers:{ ...avatarApiHeaders, "Content-Type":"application/json", "Idempotency-Key":crypto.randomUUID() },
      body:JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(avatarBusinessError(body.error?.details?.[0] || body.error, "暂时无法开始生成，请稍后重试。"));
    if (body.data?.physicianId !== submittedPhysicianId) throw avatarScopeError("任务未能保存到当前医师，请刷新后重试。");
    if (avatarScopeMatches(submittedPhysicianId, scopeEpoch)) {
      updateAvatarJobSnapshot(body.data, submittedPhysicianId);
      patchAvatarStudioDom(physician, previousJobs, ui.avatarJobs);
    }
    if (avatarScopeMatches(submittedPhysicianId, scopeEpoch)) toast(body.data.providerMode === "real" ? `${physician.name}的视频已开始生成` : `${physician.name}的演示任务已创建`, "success");
  } catch (error) {
    if (avatarScopeMatches(submittedPhysicianId, scopeEpoch)) toast(avatarBusinessError(error, "暂时无法开始生成，请稍后重试。"), "danger");
  } finally {
    if (submitToken === ui.avatarSubmitToken) ui.avatarSubmittingPhysicianId = "";
    finishAvatarMutation(submittedPhysicianId, scopeEpoch);
  }
}

async function cancelAvatarJob(generationJobId, reopenDetail = false) {
  const job = currentScopedAvatarJob(generationJobId);
  if (!job) return toast("这条任务不在当前医师的作品列表中，请刷新后重试。", "danger");
  const physicianId = job.physicianId;
  const physicianName = job.physicianName || store.physician(physicianId)?.name || "该医师";
  const physician = store.physician(physicianId) || { id:physicianId, name:physicianName };
  const scopeEpoch = ui.avatarScopeEpoch;
  const previousJobs = [...ui.avatarJobs];
  beginAvatarMutation(physicianId);
  try {
    const response = await fetch(`/api/local/physician-avatar/jobs/${encodeURIComponent(generationJobId)}/cancel?physician_id=${encodeURIComponent(physicianId)}`, { method:"POST", headers:avatarApiHeaders });
    const body = await response.json();
    if (!response.ok) throw new Error(avatarBusinessError(body.error, "暂时无法取消，请稍后重试。"));
    if (body.data?.physicianId !== physicianId) throw avatarScopeError("任务未能在当前医师列表中更新，请刷新后重试。");
    if (avatarScopeMatches(physicianId, scopeEpoch)) {
      ui.avatarJobs = ui.avatarJobs.map((item) => item.generationJobId === generationJobId ? mergeAvatarJobSnapshot(item, body.data) : item);
      ui.avatarHydratedAt = Date.now();
      patchAvatarStudioDom(physician, previousJobs, ui.avatarJobs);
      if (reopenDetail) showAvatarJobDetail(body.data);
    }
    if (avatarScopeMatches(physicianId, scopeEpoch)) toast(`${physicianName}的任务已取消；已开始生成的任务可能仍会产生费用`, "warning");
  } catch (error) { if (error.code !== "AVATAR_SCOPE_MISMATCH" && avatarScopeMatches(physicianId, scopeEpoch)) toast(avatarBusinessError(error, "暂时无法取消，请稍后重试。"), "danger"); }
  finally { finishAvatarMutation(physicianId, scopeEpoch); }
}

function updateReceptionWindow() {
  const layout=document.querySelector('.reception-page .conversation-layout');
  if(!layout)return;
  const chat=layout.querySelector('.chat-body');
  const nearBottom=!chat || chat.scrollHeight-chat.scrollTop-chat.clientHeight<48;
  if(document.visibilityState==='visible' && nearBottom)conversationReads.markRead(store.conversation(ui.conversationId));
  const template=document.createElement('template');template.innerHTML=conversationsPage();
  const next=template.content;
  for(const selector of ['.reception-filters','.conversation-items','.chat-head','.chat-body']) {
    const current=layout.querySelector(selector),incoming=next.querySelector(selector);
    if(!current||!incoming||current.innerHTML===incoming.innerHTML)continue;
    const scroll=current.scrollTop;
    const groups=new Map([...current.querySelectorAll('details')].map(d=>[d.querySelector('summary')?.textContent,d.open]));
    current.replaceChildren(...incoming.childNodes);
    current.querySelectorAll('details').forEach(d=>{const state=groups.get(d.querySelector('summary')?.textContent);if(state!==undefined)d.open=state;});
    current.scrollTop=selector==='.chat-body' && nearBottom ? current.scrollHeight : scroll;
  }
  filterReceptionList();
}

function render(preserveScroll = false) {
  const focused = preserveScroll ? document.activeElement : null;
  const focusState = focused?.id && focused.closest("#app") ? {id:focused.id, start:focused.selectionStart, end:focused.selectionEnd} : null;
  const previousInput=document.querySelector('#message-input');
  const previousChat=document.querySelector('.chat-body');
  const previousChatScroll=previousChat?.scrollTop;
  const previousChatAtBottom=!previousChat || previousChat.scrollHeight-previousChat.scrollTop-previousChat.clientHeight<48;
  const previousConversationId=previousInput?.dataset.conversationId;
  if(previousInput?.dataset.conversationId)ui.replyDrafts[previousInput.dataset.conversationId]=previousInput.value;

  if (!handoverOnlyMode) syncAvatarStudioScope();
  const y = preserveScroll ? window.scrollY : 0;
  document.querySelector("#app").innerHTML = shell(currentPage());
  hydrateListPagination();
  const replyInput=document.querySelector('#message-input');
  if(replyInput){replyInput.dataset.conversationId=ui.conversationId;replyInput.value=ui.replyDrafts[ui.conversationId]||'';}
  if (focusState) {
    const target=document.getElementById(focusState.id);
    target?.focus({preventScroll:true});
    if (typeof focusState.start === "number" && target?.setSelectionRange) target.setSelectionRange(focusState.start,focusState.end);
  }

  filterReceptionList();
  if (preserveScroll) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    document.querySelector(".chat-body")?.scrollTo(0, previousConversationId === ui.conversationId && previousChatScroll !== undefined && !previousChatAtBottom ? previousChatScroll : 999999);
    if (!handoverOnlyMode) {
      if(hasCapability("platform:manage")) hydrateLlmRuntime();
      if (routeAvatarPhysician()) hydrateAvatarStudio();
    }
    if (routeInfo().route === "knowledge" && (!handoverOnlyMode || knowledgeGovernanceEnabled) && (handoverOnlyMode || ui.knowledgeTab === "准入与发布")) hydrateKnowledgeGovernance();
    const route = routeInfo();
    if (route.route === "conversations" && route.id === "bad-cases" && !ui.badCasesHydrated && !ui.badCasesLoading) void syncBadCases();
  });
}

function showTaskModal(customerId = "") {
  const customer = customerId ? store.customer(customerId) : store.state.customers[0];
  if (!customer) {
    toast("请先创建真实客户档案，再建立关联任务", "warning");
    return;
  }
  openModal({
    title: "新建客户任务",
    desc: "任务需要明确关联客户、当前阶段、负责人、截止时间和完成标准。",
    body: `<form id="task-form"><div class="form-grid">${formField("关联客户","customerId",customer?.id || "",{type:"select",items:store.state.customers.map((item) => item.id)})}${formField("任务类型","type","人工跟进",{type:"select",items:["人工跟进","待邀约","待人工确认","到院","售后","复购"]})}${formField("任务标题","title",customer ? `跟进${customer.name}当前经营卡点` : "",{required:true,full:true})}${formField("负责人","assignee",customer?.owner || "周妍",{type:"select",items:["周妍","陈露","方琳","AI邀约专员·小美"]})}${formField("优先级","priority","中",{type:"select",items:["紧急","高","中","低"]})}${formField("截止时间","dueAt",new Date(Date.now()+3*3600000).toISOString().slice(0,16),{type:"datetime-local"})}${formField("完成标准","reason","客户状态或下一步得到确认",{full:true})}</div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="task-form">创建任务</button>`
  });
}

function showBadCaseModal(feedbackId) {
  const feedback = ui.badCases.find((item) => item.id === feedbackId);
  if (!feedback) {
    toast("未找到该Bad Case，请刷新队列后重试", "warning");
    return;
  }
  const statusLabel = {
    new:"待分析",
    triaged:"已归类",
    included_in_eval:"已纳入评测",
    dismissed:"已忽略"
  }[feedback.status] || "待分析";
  const transcript = Array.isArray(feedback.transcript) ? feedback.transcript : [];
  openModal({
    title:"Bad Case对话记录",
    desc:`${statusLabel} · ${feedback.channel || "web"} · 客户已主动标记本轮回答不符合预期。联系人信息已自动脱敏。`,
    wide:true,
    body:`<div class="stack"><div class="guardrail">${icon("shield",14)}这份记录只用于质检、回归评测与对话优化；不作为客户画像或营销触达依据。</div><section class="card conversation-transcript"><div class="transcript-body">${transcript.length ? transcript.map((message) => `<article class="transcript-message ${message.role === "assistant" ? "ai" : "customer"}"><div class="row between"><strong>${message.role === "assistant" ? "小美 · AI获客顾问" : "客户"}</strong><small>${formatDate(message.at || feedback.updated_at)}</small></div><p>${escapeHtml(message.content || "")}</p></article>`).join("") : empty("没有可展示的对话内容", "该记录可能来自历史版本")}</div></section>${feedback.review_note ? `<div class="card padded"><div class="card-title">处理备注</div><p class="page-desc">${escapeHtml(feedback.review_note)}</p></div>` : ""}</div>`,
    footer:`<button class="btn" data-action="modal-close">关闭</button>${["new", "triaged"].includes(feedback.status) ? `<button class="btn primary" data-action="review-bad-case" data-id="${escapeHtml(feedback.id)}" data-status="included_in_eval">纳入回归评测</button>` : ""}`
  });
}

async function reviewBadCaseFromUi(feedbackId, status, trigger) {
  if (!feedbackId || !status) return;
  const originalLabel = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.textContent = "正在处理…"; }
  try {
    const result = await reviewManagementBadCase(feedbackId, { status });
    const index = ui.badCases.findIndex((item) => item.id === feedbackId);
    if (index >= 0 && result.feedback) ui.badCases[index] = result.feedback;
    closeModal();
    render(true);
    toast(status === "included_in_eval" ? "已纳入回归评测，后续变更会覆盖该场景" : "该记录已标记为忽略", "success");
  } catch (error) {
    toast(error.status === 401 ? "请先完成企业实名登录" : "Bad Case处理失败，请稍后重试", error.status === 401 ? "warning" : "danger");
  } finally {
    if (trigger?.isConnected) { trigger.disabled = false; trigger.innerHTML = originalLabel; }
  }
}

function showNewConversationModal(customerId = "") {
  const eligibleCustomers = store.state.customers.filter((item) => item.origin !== "acquisition_advisor");
  if (!eligibleCustomers.length) {
    toast("当前没有可创建人工会话的客户，请先创建客户档案", "warning");
    return;
  }
  const selectedCustomer = eligibleCustomers.find((item) => item.id === customerId) || eligibleCustomers[0];
  openModal({
    title: "发起人工会话",
    desc: "此处只创建会话草稿，不会向客户自动发送消息；首条内容需在会话中单独编辑、确认并经过合规检查。",
    body: `<form id="conversation-create-form"><div class="form-grid">${formField("关联客户","customerId",selectedCustomer.id,{type:"select",items:eligibleCustomers.map((item) => item.id)})}${formField("沟通渠道","channel","企业微信",{type:"select",items:["企业微信","官网","电话摘要","线下"]})}<div class="form-group full"><div class="guardrail">${icon("shield",14)}创建后会写入客户360和审计记录，但不会产生对客触达。</div></div></div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="conversation-create-form">创建会话草稿</button>`
  });
}

function showNewJourneyModal() {
  openModal({
    title:"新建旅程草稿",
    desc:"旅程创建后默认为草稿，不会触达客户；请在画布中补齐触发、授权、人工兜底和退出条件后再提交发布。",
    body:`<form id="journey-create-form"><div class="form-grid">${formField("旅程名称","name","",{required:true})}${formField("生命周期阶段","stage","售前",{type:"select",items:["售前","售中","售后"]})}${formField("负责人","owner","",{required:true})}${formField("初始步骤（用顿号或逗号分隔）","nodes","开始条件、合规检查、人工任务、结束",{type:"textarea",full:true,required:true})}<div class="form-group full"><div class="guardrail">${icon("shield",14)}未发布草稿没有运行成员，也不能调用外部渠道。发布前会执行画布校验并留下版本记录。</div></div></div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="journey-create-form">创建草稿</button>`
  });
}

function showNewKnowledgeModal() {
  openModal({
    title: "新增知识草稿",
    desc: "当前本地环境支持录入结构化知识草稿。文档自动解析、版本审批与对客发布必须经过服务端知识工作流，草稿不会直接用于客户回答。",
    wide: true,
    body: `<form id="knowledge-create-form"><div class="form-grid">${formField("知识标题","title","",{required:true,full:true})}${formField("关联项目","project","通用",{required:true})}${formField("风险等级","risk","H1",{type:"select",items:["H1","H2","H3"]})}${formField("知识负责人","owner",store.state.currentRole,{required:true})}${formField("内容摘要","excerpt","",{type:"textarea",full:true,required:true})}${formField("来源说明","sourceReference","人工录入，待上传原始依据",{type:"textarea",full:true,required:true})}<div class="form-group full"><div class="risk-banner">${icon("alert",14)}未经过医务与合规双审的内容仅作为内部草稿保存，智能体不得将其作为院方事实回复客户。</div></div></div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="knowledge-create-form">保存知识草稿</button>`
  });
}

function showNewConnectorModal() {
  openModal({
    title: "添加连接器配置",
    desc: "仅登记连接器元数据，不保存密码、令牌或客户数据。凭据须在部署环境的密钥管理服务中单独配置。",
    body: `<form id="connector-create-form"><div class="form-grid">${formField("连接器名称","name","",{required:true})}${formField("服务商 / 系统","vendor","",{required:true})}${formField("数据方向","direction","读取",{type:"select",items:["读取","写入","双向"]})}${formField("用途说明","purpose","客户资料同步",{required:true,full:true})}<div class="form-group full"><div class="guardrail">${icon("shield",14)}新连接器默认为“待接入”，未配置服务端凭据和回调校验前，不能读写任何外部业务数据。</div></div></div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="connector-create-form">保存连接器配置</button>`
  });
}

function showManagementUserModal(userId = "") {
  const user = userId ? (store.state.managementUsers || []).find((item) => item.id === userId) : null;
  if (userId && !user) return toast("未找到该后台用户", "warning");
  const roles = (store.state.managementRoles || []).map((item) => ({ value:item.id, label:item.name }));
  if (!user && !roles.length) {
    toast("请先创建至少一个角色，再新增后台用户", "warning");
    return;
  }
  const selectedRoleId = user?.roleId || roles[0]?.value || "";
  openModal({
    title:user ? "编辑后台用户" : "新增后台用户",
    desc:"维护本地管理系统用户、所属科室、状态和已授权角色。正式生产环境应由企业 SSO 创建和停用身份。",
    body:`<form id="management-user-form" data-user-id="${escapeHtml(user?.id || "")}"><div class="form-grid">${formField("姓名","name",user?.name || "",{required:true})}${formField("售前昵称","nickname",user?.nickname || user?.name || "",{required:true})}${formField("登录账号","account",user?.account || "",{required:true})}${formField("售前 ID / 工号","staffId",user?.staffId || user?.account || "",{required:true})}${formField("所属科室","department",user?.department || "",{required:true})}${formField("角色","roleId",selectedRoleId,{type:"select",items:roles})}${formField("状态","status",user?.status || "启用",{type:"select",items:["启用","停用"]})}</div><div class="guardrail">${icon("shield",14)}售前 ID 应与企业身份或 IM 服务端的接待人标识一致，才能在会话中正确显示接待昵称与 ID。仅维护本地管理身份与角色引用；不会创建外部账号，也不会授予未包含在角色中的权限。</div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="management-user-form">${user ? "保存变更" : "保存用户"}</button>`
  });
}

function showManagementRoleModal(roleId = "") {
  const role = roleId ? (store.state.managementRoles || []).find((item) => item.id === roleId) : null;
  if (roleId && !role) return toast("未找到该角色", "warning");
  openModal({
    title:role ? "编辑角色" : "新增角色",
    desc:"角色用于限定可访问的数据范围与后台功能；高风险权限仍需额外审核。",
    body:`<form id="management-role-form" data-role-id="${escapeHtml(role?.id || "")}"><div class="form-grid">${formField("角色名称","name",role?.name || "",{required:true})}${formField("适用范围","scope",role?.scope || "",{required:true})}${formField("权限（用逗号分隔）","permissions",(role?.permissions || ["产品查看", "客户查看"]).join("，"),{type:"textarea",full:true})}${formField("状态","status",role?.status || "启用",{type:"select",items:["启用","停用"]})}</div><div class="guardrail">${icon("shield",14)}不能通过此处配置直接发布价格、绕过医务审核或读取未授权客户资料。</div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="management-role-form">${role ? "保存变更" : "保存角色"}</button>`
  });
}

function showConfigurationRecordModal(kind, recordId = "") {
  const supportedKinds = new Set(["segment", "message_template", "journey_template"]);
  if (!supportedKinds.has(kind)) return toast("不支持的运营配置类型", "warning");
  const record = recordId ? (store.state.configurationRecords || []).find((item) => item.id === recordId && item.kind === kind) : null;
  if (recordId && !record) return toast("未找到该运营配置", "warning");
  const editing = Boolean(record);
  const statusField = formField("状态", "status", record?.status || "草稿", { type:"select", items:["草稿", "启用", "停用"] });
  const formStart = `<form id="configuration-record-form" data-kind="${kind}" data-record-id="${escapeHtml(record?.id || "")}"><div class="form-grid">`;
  const guardrail = `<div class="form-group full"><div class="guardrail">${icon("shield",14)}${kind === "journey_template" ? "模板只用于创建本地旅程草稿；不会自动加入客户、发送消息或调用外部渠道。" : kind === "segment" ? "分群只计算当前系统内已保存的客户信息；关联旅程不会自动触达任何客户。" : "话术模板是表达草稿；每次对客使用前仍需结合知识、授权、阶段与合规规则复核。"}</div></div>`;
  if (kind === "message_template") {
    const variableBlock = `<div class="form-group full"><span class="form-label">变量与预览</span><div class="caption">可用变量（只允许以下命名）：${MESSAGE_TEMPLATE_VARIABLES.map((item) => `<code>{{${escapeHtml(item.name)}}}</code>`).join("、")}</div><div class="caption" style="margin-top:6px">${MESSAGE_TEMPLATE_VARIABLES.map((item) => `${escapeHtml(item.name)}＝${escapeHtml(item.description)}`).join("；")}</div><div class="caption" style="margin-top:8px">预览只保留占位符本身，不会替换成真实客户数据：</div><pre id="message-template-preview" class="caption" style="white-space:pre-wrap;margin:6px 0 0;padding:10px;border:1px solid #eadbda;border-radius:8px;background:#fffafa">${escapeHtml(renderTemplatePreview(record?.content || ""))}</pre></div>`;
    openModal({
      title:editing ? "编辑话术模板" : "新建话术模板",
      desc:`维护可复用的表达草稿。模板不存放客户数据，也不会绕过人工确认和合规门禁。${editing ? `当前版本 ${templateVersionLabel(record?.version)}，修改内容会生成新版本。` : "新模板从 v1 开始。"}`,
      wide:true,
      body:`${formStart}${formField("模板名称","name",record?.name || "",{required:true})}${formField("分类","category",record?.category || MESSAGE_TEMPLATE_CATEGORIES[0],{type:"select",items:MESSAGE_TEMPLATE_CATEGORIES})}${formField("适用环节","scope",record?.scope || "",{required:true})}${formField("使用方式","executionMode",record?.executionMode || "人工确认",{type:"select",items:["人工确认","需合规检查","强制转人工"]})}${statusField}${formField("模板内容","content",record?.content || "",{type:"textarea",full:true,required:true})}${variableBlock}${guardrail}</div></form>`,
      footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="configuration-record-form">${editing ? "保存模板" : "创建模板"}</button>`
    });
    return;
  }
  if (kind === "journey_template") {
    openModal({
      title:editing ? "编辑旅程模板" : "新建旅程模板",
      desc:"定义经过运营审核的流程骨架。使用该模板只会生成一条可继续编辑的旅程草稿。",
      wide:true,
      body:`${formStart}${formField("模板名称","name",record?.name || "",{required:true})}${formField("生命周期阶段","stage",record?.stage || "售前",{type:"select",items:["售前","售中","售后"]})}${formField("负责人（选填）","owner",record?.owner || "")}${statusField}${formField("流程步骤（用顿号、逗号或换行分隔）","nodes",(record?.nodes || []).join("、"),{type:"textarea",full:true,required:true})}${formField("模板说明（选填）","description",record?.description || "",{type:"textarea",full:true})}${guardrail}</div></form>`,
      footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="configuration-record-form">${editing ? "保存模板" : "创建模板"}</button>`
    });
    return;
  }
  const criteria = record?.criteria || {};
  const journeyOptions = [{ value:"", label:"不关联旅程" }, ...(store.state.journeys || []).map((item) => ({ value:item.id, label:item.name }))];
  openModal({
    title:editing ? "编辑动态分群" : "新建动态分群",
    desc:"至少设置一个可解释的筛选条件。系统仅用当前本地客户档案实时计算命中结果，不会自动执行触达。",
    wide:true,
    body:`${formStart}${formField("分群名称","name",record?.name || "",{required:true})}${formField("负责人（选填）","owner",record?.owner || "")}${formField("状态","status",record?.status || "草稿",{type:"select",items:["草稿","启用","停用"]})}${formField("关联旅程（选填）","journeyId",record?.journeyId || "",{type:"select",items:journeyOptions})}${formField("生命周期阶段（选填）","macroStage",criteria.macroStage || "",{type:"select",items:[{value:"",label:"不限"},"售前","售中","售后"]})}${formField("微阶段（选填）","microStage",criteria.microStage || "")}${formField("关注项目（选填）","project",criteria.project || "")}${formField("最低兴趣分（选填，0—100）","minScore",criteria.minScore ?? "",{type:"number"})}${formField("规则说明","rule",record?.rule || "",{type:"textarea",full:true,required:true})}${guardrail}</div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="configuration-record-form">${editing ? "保存分群" : "创建分群"}</button>`
  });
}

function showAuditRecordModal(auditId = "") {
  const audit = (store.state.audit || []).find((item) => item.id === auditId);
  if (!audit) return toast("未找到该审计记录", "warning");
  openModal({
    title:"审计记录详情",
    desc:"该记录来自当前本地管理服务，用于追溯后台维护、智能体运行或人工操作；页面不展示无关客户敏感信息。",
    body:`<section class="card padded"><div class="profile-list"><div class="profile-row"><span class="profile-key">记录编号</span><strong>${escapeHtml(audit.id)}</strong></div><div class="profile-row"><span class="profile-key">发生时间</span><span>${escapeHtml(formatDate(audit.at))}</span></div><div class="profile-row"><span class="profile-key">执行者</span><span>${escapeHtml(audit.actor || "系统")}</span></div><div class="profile-row"><span class="profile-key">操作</span><span>${escapeHtml(audit.action || "未填写")}</span></div><div class="profile-row"><span class="profile-key">业务对象</span><span>${escapeHtml(audit.object || "未填写")}</span></div><div class="profile-row"><span class="profile-key">执行结果</span><span>${escapeHtml(audit.result || "未填写")}</span></div><div class="profile-row"><span class="profile-key">风险等级</span>${badge(audit.severity || "低", audit.severity === "高" ? "danger" : audit.severity === "中" ? "warning" : "success")}</div></div></section>`,
    footer:`<button class="btn primary" data-action="modal-close">关闭</button>`
  });
}

function showProductModal(productId = "") {
  const product = productId ? (store.state.products || []).find((item) => item.id === productId) : null;
  if (productId && !product) return toast("未找到该产品记录", "warning");
  const value = (field, fallback = "") => product?.[field] ?? fallback;
  const editing = Boolean(product);
  openModal({
    title:editing ? "编辑产品" : "新增产品",
    desc:"维护产品的经营资料、销售状态、负责人、展示说明和价格信息。价格作为产品字段保存，不单独建立价格模块。",
    wide:true,
    body:`<form id="product-form" data-product-id="${escapeHtml(product?.id || "")}"><div class="form-grid">${formField("产品名称","name",value("name"),{required:true})}${formField("产品编码","productCode",value("productCode"),{required:true})}${formField("所属科室","department",value("department"),{required:true})}${formField("产品分类","category",value("category"),{required:true})}${formField("服务类型","serviceType",value("serviceType","医美项目"),{type:"select",items:["医美项目","治疗服务","皮肤管理","会员权益","套餐服务"]})}${formField("销售状态","salesStatus",value("salesStatus","待完善"),{type:"select",items:["待完善","待审核","在售","预售","停售"]})}${formField("资料审核状态","approvalStatus",value("approvalStatus","待审核"),{type:"select",items:["待审核","审核中","已通过","退回修改"]})}${formField("负责人","owner",value("owner"),{required:true})}${formField("适用院区","branch",value("branch"),{required:true})}${formField("经营渠道","channel",value("channel"),{required:true})}<div class="form-group full"><div class="divider"></div><strong>价格信息</strong><div class="caption" style="margin-top:4px">价格与产品统一维护；已提取的资料参考价须运营人员核验后，才可作为正式价格使用。</div></div>${formField("价格类型","priceType",value("priceType","未录入价格"),{type:"select",items:["未录入价格","资料参考价","标准价","活动价","会员价","套餐价","面诊价"]})}${formField("产品价格","price",value("price"))}${formField("划线价 / 原价","originalPrice",value("originalPrice"))}${formField("价格审核状态","priceApprovalStatus",value("priceApprovalStatus","待核验"),{type:"select",items:["暂无可匹配价格资料","待核验","待审核","业务复核中","医务复核中","合规复核中","已通过","退回修改"]})}${formField("价格适用范围与条件","priceApplicableScope",value("priceApplicableScope"),{type:"textarea",full:true})}${formField("价格生效日期","priceEffectiveAt",value("priceEffectiveAt"),{type:"date"})}${formField("价格失效日期（选填）","priceExpiresAt",value("priceExpiresAt"),{type:"date"})}${formField("项目亮点","highlights",value("highlights"),{type:"textarea",full:true})}${formField("运营说明","description",value("description"),{type:"textarea",full:true})}<div class="form-group full"><div class="guardrail">${icon("shield",14)}即使资料审核状态标记为“已通过”，对客回答仍只使用已发布的知识版本；价格还必须通过有效期和审批校验。</div></div></div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="product-form">${editing ? "保存产品资料" : "创建产品"}</button>`
  });
}

function showAgendaModal() {
  const tasks = [...store.state.tasks]
    .filter((item) => !["已完成", "已取消"].includes(item.status))
    .sort((left, right) => Date.parse(left.dueAt || 0) - Date.parse(right.dueAt || 0))
    .slice(0, 20);
  openModal({
    title: "完整日程",
    desc: "仅汇总当前管理端可见的待办与人工跟进任务；预约系统未接入前，不展示或推测医生排班与可约名额。",
    wide: true,
    body: tasks.length ? `<div class="stack">${tasks.map((task) => `<div class="responsibility-row"><span class="responsibility-icon">${icon(task.priority === "紧急" ? "alert" : "clock",15)}</span><div><strong style="font-size:12px">${escapeHtml(task.title)}</strong><div class="caption">${escapeHtml(task.assignee || "待分配")} · ${task.dueAt ? formatDate(task.dueAt) : "截止时间待确认"} · ${escapeHtml(task.status || "待处理")}</div></div></div>`).join("")}</div>` : empty("暂无待处理日程", "新建人工跟进任务后会在此显示"),
    footer: `<button class="btn primary" data-action="modal-close">关闭</button>`
  });
}

function showUnavailableManagementAction(action, trigger) {
  const definitions = {
    "approval-preview":["审批详情", "当前演示列表未绑定真实审批单号；请在已接入的知识审批工作流中查看原文、审核意见和操作人。"],
    "approval-pass":["通过审批", "当前演示列表未绑定真实审批单号。为避免错误发布，本次不会改变任何知识或对客版本状态。"],
    "duplicate-compare":["重复客户对比", "客户合并涉及身份信息与隐私边界；没有可靠身份匹配依据时，系统不会展示或合并记录。"],
    "duplicate-merge":["确认客户合并", "当前环境未接入身份核验与客户主数据服务。本次不会合并任何客户档案。"],
    "template-preview":["模板预览", "当前模板目录为产品示例。接入模板版本库后可在此查看变量、适用范围和合规状态。"],
    "template-copy":["复制模板", "当前环境没有模板版本库，本次不会创建未受控的对客内容副本。"],
    "template-new":["新建模板", "模板管理需要版本、审核和发布服务。服务未接入前，系统不会创建可被误用的模板。"],
    "use-journey-template":["使用旅程模板", "旅程模板需要经过版本校验和测试客户验证；当前没有已接入的模板服务，本次不创建旅程。"],
    "journey-optimize":["生成优化建议", "优化建议依赖真实指标与批准的评测集。当前演示指标不能生成可执行建议。"],
    "log-detail":["处理记录", "当前示例日志未绑定服务端事件编号；接入审计服务后可在此查看完整依据和处理链路。"],
    "rule-detail":["规则详情", "当前示例规则未绑定可编辑的服务端版本；为保持合规边界，本次不开放本地修改。"],
    "audit-detail":["审计记录", "当前示例记录未绑定不可篡改的服务端审计事件；请使用已接入的审计服务查询完整记录。"],
    "mapping-detail":["字段映射", "字段映射必须绑定具体连接器版本和字段契约；当前示例数据不支持直接修改。"],
    "new-mapping":["新增字段映射", "请先完成连接器配置与字段契约校验；未接入外部系统前不能创建会被误认为生效的映射。"],
    "new-member":["新增成员", "组织成员与权限范围必须由企业 SSO 同步。当前页面不能自行创建或扩大人员权限。"],
    "stage-config":["阶段配置", "生命周期配置会影响客户运营链路，需由服务端版本化规则引擎承载；本地演示不直接修改。"],
    "project-new":["新增项目字典", "项目字典需要关联正式知识版本与审核流程；当前环境不直接新增对客项目。"],
    "role-detail":["角色权限", "当前页面仅展示权限模型。实际角色、院区与科室范围必须来自企业 SSO，不允许前端直接变更。"],
    "version-detail":["版本记录", "当前页面没有接入版本服务。部署后应由服务端提供不可篡改的版本、审批与回滚记录。"],
    "knowledge-source":["知识来源与溯源", "当前本地示例未保存原始资料文件。对客知识的原文、来源文件和审核意见必须在受控知识服务中查询。"],
    "knowledge-version":["知识版本", "当前本地示例不允许修改版本或直接发布。请通过服务端知识工作流创建、审核并激活新版本。"],
    "connector-events":["连接器事件日志", "尚未配置连接器，因此没有可验证的同步事件。配置凭据、回调验签和字段映射后才会在这里展示事件。"],
    "segment-edit":["编辑分群规则", "动态分群规则需要由服务端规则引擎编译、版本化和回滚；当前本地示例不直接保存修改。"],
    "segment-activate":["将分群加入旅程", "执行前必须检查授权、频控、互斥规则和旅程版本。当前演示数据不执行批量客户操作。"],
    "new-agent":["新增 AI 员工", "AI 员工需要服务端登记职责、工具权限、知识范围、评测门槛和人工负责人后才可启用。"],
    "add-node":["新增旅程节点", "当前画布没有接入可版本化的旅程编排服务，本次不会保存可能影响客户触达的节点。"],
    "test-journey":["旅程试运行", "正式试运行需指定测试客户、规则版本和回放结果。当前没有可核验的试运行服务，因此不报告通过。"],
    "save-journey":["保存旅程", "当前画布未接入版本化旅程服务；为避免覆盖运行中客户流程，本次不保存。"],
    "new-journey":["新建旅程", "新旅程需由服务端生成版本、审批和回滚点。当前本地环境不创建可运行的自动触达旅程。"],
    "run-eval":["能力检查", "正式能力检查必须运行固定回归集并保存模型、提示词、知识版本和结果证据。当前页面不以静态提示代替评测。"],
    "rule-test":["回答安全检查", "正式安全检查必须调用评测服务并保存可追溯结果。当前页面不以静态提示代替测试。"],
    "save-mapping":["保存字段映射", "映射草稿尚未绑定真实连接器版本，本次不会保存或启用任何数据同步规则。"],
    "save-settings":["保存设置", "当前设置页没有已授权的服务端配置接口，本次不会写入任何运行参数。"]
  };
  const [title, description] = definitions[action] || ["功能待接入", "该入口尚未接入可执行服务，本次未执行任何变更。"];
  const source = String(trigger?.closest("tr")?.innerText || "").trim().slice(0, 500);
  openModal({
    title,
    desc: "当前页面已明确阻断未接入的写操作，避免出现假成功或无审计变更。",
    body: `<div class="stack"><div class="risk-banner">${icon("shield",15)}${escapeHtml(description)}</div>${source ? `<div class="card padded"><div class="card-title">当前选中记录</div><p class="page-desc">${escapeHtml(source)}</p></div>` : ""}</div>`,
    footer: `<button class="btn primary" data-action="modal-close">我已了解</button>`
  });
}

function showProfileModal(customerId) {
  const customer = store.customer(customerId);
  openModal({
    title: `编辑${customer.name}的客户画像`,
    desc: "请根据已确认的客户信息进行修改，保存后会更新后续跟进建议。",
    body: `<form id="profile-form" data-customer-id="${customer.id}"><div class="form-grid">${formField("预算区间","budget",customer.profile.budget)}${formField("决策方式","decision",customer.profile.decision)}${formField("联系偏好","contact",customer.profile.contact)}${formField("沟通风格","style",customer.profile.style)}${formField("核心顾虑","concern",customer.profile.concern,{full:true})}${formField("客户标签（顿号分隔）","tags",customer.tags.join("、"),{full:true})}${formField("修改依据","evidence","人工沟通确认",{type:"textarea",full:true,required:true})}</div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="profile-form">保存并重算策略</button>`
  });
}

function showStageModal(customerId) {
  const customer = store.customer(customerId);
  openModal({
    title: `推进${customer.name}的生命周期`,
    desc: "请根据已确认的预约、到院、项目或随访记录更新客户阶段。",
    body: `<form id="stage-form" data-customer-id="${customer.id}"><div class="form-grid">${formField("客户阶段","macroStage",customer.macroStage,{type:"select",items:["售前","售中","售后"]})}${formField("当前环节","microStage",customer.microStage,{type:"select",items:Object.values(stageSteps).flat()})}${formField("阶段依据","evidence","客户确认预约/外部系统事件/人工核实",{type:"textarea",full:true,required:true})}${formField("阻塞原因","blockReason","无",{full:true})}</div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="stage-form">确认推进</button>`
  });
}

function showPhotoModal(customerId) {
  const customer = store.customer(customerId);
  openModal({
    title: "客户照片与授权",
    desc: "照片只用于经授权的客户服务场景，不用于面部诊断、颜值评分或项目适用性判断。",
    body: `<form id="photo-form" data-customer-id="${customer.id}"><div class="row" style="align-items:flex-start">${avatar(customer,"lg")}<div class="stack" style="flex:1"><div class="profile-row"><span class="profile-key">当前状态</span><span>${badge(customer.photoConsent,customer.photoConsent === "已授权" ? "success" : "danger")}</span></div><div class="profile-row"><span class="profile-key">最近更新</span><span>${formatDate(customer.photoUpdatedAt)}</span></div><div class="profile-row"><span class="profile-key">用途限制</span><span>身份辅助、服务记录；禁止AI诊断</span></div></div></div><div class="divider"></div>${formField("授权状态","photoConsent",customer.photoConsent,{type:"select",items:["已授权","待确认","已撤回","未上传"],full:true})}${formField("记录依据","evidence","客户主动确认/授权文本版本 v1.0",{type:"textarea",full:true})}</form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="photo-form">更新授权</button>`
  });
}

function showEvidenceModal(customerId) {
  const customer = store.customer(customerId);
  openModal({ title: "下一步建议依据", desc: "建议只使用当前授权范围内、可追溯且仍有效的信息。", body: `<div class="stack"><div class="card padded"><div class="card-title">当前建议</div><p class="page-desc">${customer.nextAction.title}</p></div>${customer.timeline.slice(0,3).map((item,index) => `<div class="responsibility-row"><span class="node-dot">${index+1}</span><div><strong style="font-size:11px">${item.title}</strong><div class="caption" style="margin-top:4px">${item.detail}</div></div></div>`).join("")}<div class="guardrail">${icon("shield",14)}${customer.nextAction.guardrail}</div></div>`, footer: `<button class="btn primary" data-action="modal-close">我已了解</button>` });
}

function showReassignModal(customerId) {
  const customer = store.customer(customerId);
  openModal({ title: "变更责任链", desc: "AI执行不改变人工主责的最终客户关系责任。", body: `<form id="reassign-form" data-customer-id="${customer.id}"><div class="form-grid">${formField("人工主责","owner",customer.owner,{type:"select",items:["周妍","陈露","方琳","顾薇"]})}${formField("主责AI","agent",customer.agent,{type:"select",items:store.state.agents.filter((agent) => agent.id !== "A-06").map((agent) => agent.name)})}${formField("变更原因","evidence","团队分配调整",{type:"textarea",full:true,required:true})}</div></form>`, footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="reassign-form">确认变更</button>` });
}

function showJourneyModal(customerId) {
  const customer = store.customer(customerId);
  const runningJourneys = store.state.journeys.filter((item) => item.status === "运行中");
  if (!customer) return toast("未找到客户档案", "warning");
  if (!runningJourneys.length) {
    toast("暂无已发布旅程，请先在自动化运营中创建并发布旅程", "warning");
    return;
  }
  openModal({ title: `将${customer.name}加入旅程`, desc: "入组前需要由运营人员核对客户授权、频控与互斥条件。", body: `<form id="join-journey-form" data-customer-id="${customer.id}"><div class="form-grid">${formField("目标旅程","journeyId",runningJourneys[0].id,{type:"select",items:runningJourneys.map((item) => ({ value:item.id, label:item.name }))})}${formField("入组方式","entry","从首节点开始",{type:"select",items:["从首节点开始","从当前匹配节点开始"]})}<div class="form-group full"><div class="guardrail">${icon("shield",14)}请在提交前确认客户服务授权、触达频控和互斥旅程；系统会记录本次人工确认。</div></div></div></form>`, footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="join-journey-form">确认加入</button>` });
}

function showFieldMapModal(connectorId) {
  const connector = store.state.connectors.find((item) => item.id === connectorId);
  openModal({ title: `${connector.name}字段映射`, desc: "当前为示例配置；完成真实系统接入后，再按实际字段确认。", wide: true, body: `<table class="data-table"><thead><tr><th>外部字段</th><th>统一字段</th><th>方向</th><th>转换规则</th><th>必填</th></tr></thead><tbody>${[["customer_no","customer_id","写入","字符串归一","是"],["mobile","mobile_hash","双向","哈希/脱敏","是"],["stage/status","lifecycle_stage","写入","事件重算","否"],["project_code","project_id","双向","项目别名映射","否"],["staff_id","owner_id","写入","组织人员映射","否"]].map((row) => `<tr>${row.map((cell,index) => `<td>${index === 4 ? badge(cell,cell === "是" ? "brand" : "outline") : cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`, footer: `<button class="btn" data-action="modal-close">关闭</button><button class="btn primary" data-action="save-mapping">保存配置草稿</button>` });
}

function showAgentModal(agentId) {
  const agent = store.state.agents.find((item) => item.id === agentId);
  if (!agent) return toast("未找到该智能体档案，请刷新后重试", "warning");
  const mandatory = isMandatoryAgent(agent);
  const knowledgeScope = agent.knowledgeScope || {};
  const gate = agent.evaluationGate || {};
  const taskRows = store.state.tasks.filter((task) => task.assignee.includes(agent.name.split("·")[0]) || task.assignee === agent.name).slice(0, 4);
  openModal({
    title: agent.name,
    desc: `${agent.role} · ${agentExecutionLabel(agent.levelCode || agent.level)}`,
    wide: true,
    body: `<div class="grid agent-detail-grid"><div class="stack"><div class="card padded"><div class="card-title">岗位职责与能力边界</div><p class="page-desc">${escapeHtml(agent.role)}。执行前会检查客户授权、联系频次、医疗边界和已发布知识范围。</p><div class="caption" style="margin-top:12px">职责</div><div class="skill-list">${(agent.responsibilities || []).map((item) => badge(item,"brand")).join("") || badge("待配置","outline")}</div><div class="caption" style="margin-top:12px">可处理事项</div><div class="skill-list">${(agent.skills || []).map((item) => badge(item,"success")).join("") || badge("待配置","outline")}</div></div><div class="card padded"><div class="card-title">知识与评测准入</div><div class="profile-list"><div class="profile-row"><span class="profile-key">默认知识范围</span><strong>${escapeHtml(agentKnowledgeLabel(agent.knowledge))}</strong></div><div class="profile-row"><span class="profile-key">知识标签</span><span>${escapeHtml((knowledgeScope.labels || []).join("、") || "待配置")}</span></div><div class="profile-row"><span class="profile-key">负责人</span><span>${escapeHtml(agent.owner || "待配置")}${agent.ownerId ? ` · ${escapeHtml(agent.ownerId)}` : ""}</span></div><div class="profile-row"><span class="profile-key">版本</span><span>${escapeHtml(agent.version || "待配置")}</span></div><div class="profile-row"><span class="profile-key">固定回归集</span><span>${escapeHtml(gate.suite || "待配置")}</span></div><div class="profile-row"><span class="profile-key">评测结果</span><span>${escapeHtml(agentEvaluationCopy(agent))}（门槛 ${gate.minimumScore ?? agent.evaluationThreshold ?? "—"} 分）</span></div></div></div><div class="card padded"><div class="card-title">不可执行</div><div class="skill-list">${(agent.forbidden || []).map((item) => badge(item,"danger")).join("") || badge("待配置","outline")}</div>${mandatory ? `<div class="guardrail" style="margin-top:12px">${icon("shield",14)}该记录是系统强制合规守门员，不可停用或删除。</div>` : ""}</div></div><div class="card padded"><div class="card-title">最近工作记录</div>${taskRows.map((task) => `<div class="agenda-row"><div>${icon("spark",15)}</div><div><div class="agenda-title">${escapeHtml(task.title)}</div><div class="agenda-meta">${escapeHtml(task.status)} · ${escapeHtml(task.source)}</div></div></div>`).join("") || `<div class="empty">暂无直接任务记录</div>`}</div></div>`,
    footer: `<button class="btn" data-action="modal-close">关闭</button>${mandatory ? "" : `<button class="btn" data-action="edit-agent" data-id="${escapeHtml(agent.id)}">编辑配置</button>`}<a class="btn primary" href="#/agents/evaluations">查看评测状态</a>`
  });
}

function showAgentMaintenanceModal(agentId = "") {
  const agent = agentId ? store.state.agents.find((item) => item.id === agentId) : null;
  if (agentId && !agent) return toast("未找到该智能体档案，请刷新后重试", "warning");
  if (agent && isMandatoryAgent(agent)) return toast("系统强制合规守门员不可通过运营页面修改", "warning");
  const editing = Boolean(agent);
  const scope = agent?.knowledgeScope || {};
  const gate = agent?.evaluationGate || {};
  const value = (key, fallback = "") => agent?.[key] ?? fallback;
  const listValue = (key, fallback = []) => (agent?.[key] || fallback).join("、");
  const evaluationScore = gate.lastScore ?? agent?.lastEval ?? "";
  openModal({
    title: editing ? `编辑智能体 · ${escapeHtml(agent.name)}` : "新增智能体",
    desc: "保存后生成可审计的岗位档案。新记录默认处于草稿；只有岗位、知识、负责人、版本和评测证据完整时，才允许进入试运行或运行中。",
    wide: true,
    body: `<form id="agent-form" data-agent-id="${escapeHtml(agent?.id || "")}"><div class="form-grid">
      ${formField("智能体名称","name",value("name"),{required:true})}
      ${formField("岗位职责","role",value("role"),{required:true})}
      ${formField("人工负责人","owner",value("owner"),{required:true})}
      ${formField("负责人 ID（选填）","ownerId",value("ownerId"))}
      ${formField("配置版本","version",value("version","v0.1"),{required:true})}
      ${formField("运行状态","status",value("status","草稿"),{type:"select",items:["草稿","试运行","运行中","已停用"]})}
      ${formField("执行级别","levelCode",value("levelCode","L1_APPROVAL"),{type:"select",items:[{value:"L1_APPROVAL",label:"L1 · 工作人员确认后执行"},{value:"L2_CONTROLLED",label:"L2 · 规则范围内自动执行"}]})}
      ${formField("默认知识范围","knowledge",value("knowledge","已发布内部知识库"),{required:true})}
      ${formField("岗位职责（顿号、逗号或换行分隔）","responsibilities",listValue("responsibilities",[value("role")]),{type:"textarea",full:true,required:true})}
      ${formField("允许能力（顿号、逗号或换行分隔）","skills",listValue("skills"),{type:"textarea",full:true,required:true})}
      ${formField("禁止动作（顿号、逗号或换行分隔）","forbidden",listValue("forbidden"),{type:"textarea",full:true,required:true})}
      ${formField("知识范围标签（顿号、逗号或换行分隔）","knowledgeScopeLabels",(scope.labels || [value("knowledge")]).join("、"),{type:"textarea",full:true,required:true})}
      ${formField("适用项目 / 科室（选填，顿号、逗号或换行分隔）","projectScopes",(scope.projectScopes || []).join("、"),{type:"textarea",full:true})}
      ${formField("评测集名称","evaluationSuite",gate.suite || "一期固定回归集",{required:true})}
      ${formField("准入最低分（0—100）","evaluationThreshold",gate.minimumScore ?? value("evaluationThreshold",95),{type:"number",required:true})}
      ${formField("最近评测得分（0—100，选填）","lastEval",evaluationScore,{type:"number"})}
      ${formField("评测证据编号 / 链接（选填）","evidenceRef",gate.evidenceRef || "",{full:true})}
      <div class="form-group full"><div class="guardrail">${icon("shield",14)}这是一份运营配置档案，不会直接修改正在运行的模型、提示词或外部渠道。变更运行时配置前仍需完成部署审批、回归评测和可回滚发布；未达到评测门槛的“运行中”请求会由服务端本地规则自动回退为草稿。</div></div>
    </div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="agent-form">${editing ? "保存智能体配置" : "创建智能体草稿"}</button>`
  });
}

function showDeleteAgentModal(agentId) {
  const agent = store.state.agents.find((item) => item.id === agentId);
  if (!agent) return toast("未找到该智能体档案，请刷新后重试", "warning");
  if (isMandatoryAgent(agent)) return toast("系统强制合规守门员不可删除", "warning");
  openModal({
    title:`删除智能体 · ${escapeHtml(agent.name)}`,
    desc:`${escapeHtml(agent.role)} · ${escapeHtml(agent.version || "版本待配置")}`,
    body:`<div class="risk-banner">${icon("alert",16)}删除后，该岗位不再出现在运营配置中；系统会保留本次删除的审计记录。</div><p class="page-desc">如果仍有关联客户，系统会拒绝删除。请先完成客户责任链转交或将该智能体停用。</p>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn danger" data-action="confirm-delete-agent" data-id="${escapeHtml(agent.id)}">确认删除</button>`
  });
}

function showPhysicianModal(physicianId = "") {
  const physician = physicianId ? store.physician(physicianId) : null;
  const title = physician ? `编辑医师 · ${escapeHtml(physician.name)}` : "新增医师";
  openModal({
    title,
    desc: "维护医师基本资料、执业信息、排班状态与擅长领域；保存后会同步到医师列表。",
    wide: true,
    body: `<form id="physician-form" data-physician-id="${physician?.id || ""}"><div class="form-grid">
      ${formField("医师姓名","name",physician?.name || "",{required:true})}
      ${formField("性别","gender",physician?.gender || "女",{type:"select",items:["女","男","其他"]})}
      ${formField("职称","title",physician?.title || "主治医师",{type:"select",items:["主任医师","副主任医师","主治医师","执业医师"]})}
      ${formField("所属科室","department",physician?.department || "美容外科",{type:"select",items:["美容外科","皮肤美容科","微创美容科","美容牙科","麻醉科"]})}
      ${formField("所属院区","branch",physician?.branch || "时代之美·总院",{required:true})}
      ${formField("出诊状态","status",physician?.status || "出诊中",{type:"select",items:["出诊中","手术日","进修中","休诊"]})}
      ${formField("从业年限","years",physician?.years ?? 0,{type:"number",required:true})}
      ${formField("教育背景","education",physician?.education || "医学本科")}
      ${formField("院内角色","hospitalTenure",physician?.hospitalTenure || "团队医师")}
      ${formField("联系电话","mobile",physician?.mobile || "138****0000")}
      ${formField("执业证书编号","registrationNo",physician?.registrationNo || "")}
      ${formField("执业范围","registrationScope",physician?.registrationScope || "外科专业")}
      ${formField("常规排班","schedule",physician?.schedule || "待排班",{full:true})}
      ${formField("擅长领域（顿号分隔）","specialties",physician?.specialties?.join("、") || "",{full:true,required:true})}
      ${formField("代表项目（顿号分隔）","signatureProjects",physician?.signatureProjects?.join("、") || "",{full:true})}
      ${formField("医师简介","bio",physician?.bio || "",{type:"textarea",full:true})}
    </div></form>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="physician-form">${physician ? "保存修改" : "创建医师档案"}</button>`
  });
}

function showDeletePhysicianModal(physicianId) {
  const physician = store.physician(physicianId);
  if (!physician) return toast("未找到该医师档案", "danger");
  openModal({
    title: `删除医师 · ${escapeHtml(physician.name)}`,
    desc: `${escapeHtml(physician.title)} · ${escapeHtml(physician.department)}`,
    body: `<div class="risk-banner">${icon("alert",16)}删除后，该医师将从团队列表和擅长领域分布中移除，系统仍会保留本次操作记录。</div><p class="page-desc">如只是暂时不出诊，建议将状态改为“休诊”，以保留历史团队资料。</p>`,
    footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn danger" data-action="confirm-delete-physician" data-id="${physician.id}">确认删除</button>`
  });
}

function showKnowledgeApproval(id) {
  const item = store.state.knowledge.find((knowledge) => knowledge.id === id);
  const medicalPassed = ["待合规审核","已发布"].includes(item.status);
  const compliancePassed = item.status === "已发布";
  const nextAction = item.status === "待医务与合规审核"
    ? ["submit-knowledge-review","提交医务初审"]
    : item.status === "待医务审核"
      ? ["confirm-medical-knowledge","医务通过，提交合规"]
      : ["confirm-knowledge","合规通过并发布"];
  const rawNotice = item.sourceId ? `<div class="risk-banner">${icon("alert",14)}这是逐卡采集的原始项目资料，必须经过医务与合规审核后才能用于正式回答。</div>` : "";
  openModal({ title: "知识发布审批", desc: `${item.title} · ${item.version} · ${knowledgeRiskLabel(item.risk)}`, wide: true, body: `<div class="grid cols-2"><div class="card padded"><div class="card-title">待审批内容摘要</div><p class="page-desc">${escapeHtml(item.excerpt)}</p><div class="divider"></div><div class="profile-list"><div class="profile-row"><span class="profile-key">知识用途</span><span>${knowledgeLayerLabel(item.layer)}</span></div><div class="profile-row"><span class="profile-key">风险分级</span><span>${badge(knowledgeRiskLabel(item.risk),item.risk==="H3"?"danger":"warning")}</span></div><div class="profile-row"><span class="profile-key">医务审核</span><span>${badge(medicalPassed?"已通过":"待确认",medicalPassed?"success":"warning")}</span></div><div class="profile-row"><span class="profile-key">合规审核</span><span>${badge(compliancePassed?"已通过":"待确认",compliancePassed?"success":"warning")}</span></div></div></div><div class="card padded"><div class="card-title">发布前检查</div><div class="stack" style="margin-top:12px">${["来源与逐卡采集证据完整","介绍、功效与流程已结构化","医疗边界与转人工条件已配置","宣传用语需完成逐项复核"].map((text) => `<div class="row">${icon("check",15,"muted")}<span>${text}</span></div>`).join("")}</div>${rawNotice}</div></div>`, footer: `<button class="btn danger" data-action="reject-knowledge" data-id="${item.id}">退回修改</button><button class="btn primary" data-action="${nextAction[0]}" data-id="${item.id}">${nextAction[1]}</button>` });
}

function downloadText(name, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function runAgentApiConsole(useRouter = false, trigger) {
  const responsePanel = document.querySelector("#api-response");
  const statusLabel = document.querySelector("#api-response-status");
  const agentId = document.querySelector("#api-agent-id")?.value || "A-01";
  const customerId = document.querySelector("#api-customer-id")?.value || "";
  const message = document.querySelector("#api-message")?.value.trim();
  const mode = document.querySelector("#api-mode")?.value || "assist";
  const stage = document.querySelector("#api-stage")?.value || "售前";
  const marketingConsent = Boolean(document.querySelector("#api-marketing-consent")?.checked);
  const apiKey = document.querySelector("#api-key")?.value.trim();
  if (!message) return toast("请输入客户消息或任务", "warning");
  if (!apiKey) return toast("请输入API Key", "warning");
  const originalLabel = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.textContent = "调用中…"; }
  if (statusLabel) { statusLabel.textContent = "请求中"; statusLabel.className = "api-status pending"; }
  try {
    const endpoint = useRouter ? "/api/v1/router/invoke" : `/api/v1/agents/${agentId}/invoke`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "Idempotency-Key": `ui-${Date.now()}` },
      body: JSON.stringify({
        ...(customerId ? { customer_id:customerId } : {}),
        message, channel: "management_console", mode,
        context: {
          macro_stage: stage,
          service_consent: true,
          marketing_consent: marketingConsent
        }
      })
    });
    const data = await response.json();
    if (responsePanel) responsePanel.textContent = JSON.stringify(data, null, 2);
    if (statusLabel) {
      statusLabel.textContent = response.ok ? `${data.status || "success"} · ${response.status}` : `${data.error?.code || "error"} · ${response.status}`;
      statusLabel.className = `api-status ${response.ok ? data.status || "success" : "error"}`;
    }
    toast(response.ok ? `调用成功：${data.agent?.name || "自动路由"}` : `调用失败：${data.error?.message || response.status}`, response.ok ? "success" : "danger");
  } catch (error) {
    if (responsePanel) responsePanel.textContent = JSON.stringify({ error: { code: "NETWORK_ERROR", message: error.message } }, null, 2);
    if (statusLabel) { statusLabel.textContent = "网络错误"; statusLabel.className = "api-status error"; }
    toast("无法连接本地AI员工API", "danger");
  } finally {
    if (trigger) { trigger.disabled = false; trigger.innerHTML = originalLabel; }
  }
}

async function copyApiCurl() {
  const command = document.querySelector("#api-curl-example")?.textContent || "";
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    toast("cURL命令已复制", "success");
  } catch {
    toast("浏览器未授权剪贴板，请手动复制代码块", "warning");
  }
}

async function handleAction(action, id, target) {
  if (action === "reception-tab") { ui.receptionTab=id;render(true);return; }
  if (action === "copy-reply-draft") { const text=document.querySelector('#message-input')?.value.trim();if(!text)return toast('请先输入回复内容','warning');try{await navigator.clipboard.writeText(text);toast('回复已复制，请在已批准渠道确认发送','success');}catch{toast('复制失败，请选中文本手动复制','warning');}return; }

  if (action === "admin-logout") { try { target.disabled=true;await logoutAdminSession();clearKnowledgeIntakeFilterState(); } catch(error){toast(error.message,"error");target.disabled=false;} return; }
  if (action === "list-page") {
    const listKey = target?.dataset.listKey;
    if (!listKey) return;
    const state = ui.listPagination[listKey] || {};
    ui.listPagination[listKey] = { ...state, page:Math.max(1, Number(id) || 1) };
    hydrateListPagination();
    return;
  }
  if (action === "refresh-publications") {await refreshPublications();return;}
  if (action === "build-publication") {showPublicationModal('', 'build');return;}
  if (action === "publication-evaluate") {showPublicationModal(id,'evaluate');return;}
  if (action === "publication-activate") {showPublicationModal(id,'activate');return;}
  if (action === "publication-rollback") {showPublicationModal(id,'rollback');return;}
  if (action === "publication-withdraw") {showPublicationModal(id,'withdraw');return;}
  if (action === "connection-details") {
    const items=[["会话与接待",ui.operationsError],["客户同步",ui.conversationSyncError],["人员账号",ui.accountError],["会员查询配置",ui.memberIntegrationError],["知识发布",ui.publicationError],["资料保存",ui.managementPersistenceState === "error" ? "最近修改尚未保存，请重试" : ""]];
    openModal({title:"服务状态详情",desc:"各模块分别显示状态，单个模块异常不代表所有功能不可用。",body:items.map(([name,error])=>`<p><strong>${name}</strong>：${escapeHtml(error || "未报告异常")}</p>`).join(""),footer:'<button class="btn primary" data-action="modal-close">关闭</button>'});return;
  }
  if (action === "managed-accounts-refresh") {await refreshManagedAccounts();toast(ui.accountError||'已读取最新服务端状态',ui.accountError?'warning':'success');return;}
  if (action === "managed-account-new") {showManagedAccountModal('');return;}
  if (action === "managed-account-edit") {showManagedAccountModal(id);return;}
  if (handoverOnlyMode && !realManagementActions.has(action)) {
    toast("该操作尚未接入正式服务，生产模式未执行任何变更", "warning");
    return;
  }
  if (isPresalesWorkspace() && !presalesAllowedActions.has(action)) {
    toast("售前人员仅可处理进入接待队列的会话、人工接管、预约确认和已启用话术", "warning");
    return;
  }
  switch (action) {
    case "reload-management-data": await hydrateManagementDomain({ announce:true }); break;
    case "modal-close":
      if (unsavedFormDirty && !globalThis.confirm("当前表单有未保存的修改，确定放弃并关闭吗？")) break;
      markUnsavedFormDirty(false);
      clearRevealedContact({ markHidden:false }); closeModal(); break;
    case "refresh":
      if (handoverOnlyMode) {
        await Promise.all([syncAcquisitionHandovers(true), syncAppointmentOperations(true)]);
      } else {
        await Promise.all([syncAcquisitionCustomers(), syncAcquisitionHandovers(true), syncAppointmentOperations(true)]);
        toast("客户、人工接管与预约队列已更新", "success");
      }
      break;
    case "refresh-handovers": await syncAcquisitionHandovers(true); break;
    case "reveal-appointment-contact": await revealHandoverContactFromUi(id, target, { appointment:true }); break;
    case "refresh-appointments": await syncAppointmentOperations(true); break;
    case "refresh-bad-cases": await syncBadCases(true); break;
    case "view-bad-case": showBadCaseModal(id); break;
    case "review-bad-case": await reviewBadCaseFromUi(id, target?.dataset.status, target); break;
    case "claim-handover": await claimHandoverFromUi(id, target); break;
    case "claim-appointment": await claimAppointmentFromUi(id, target); break;
    case "resolve-appointment": await showResolveAppointmentModal(id); break;
    case "reveal-contact": await revealHandoverContactFromUi(id, target); break;
    case "complete-handover": showCompleteHandoverModal(id); break;
    case "robot-takeover": showCompleteHandoverModal(id, { resumeRobot:true }); break;
    case "agenda": showAgendaModal(); break;
    case "new-task": showTaskModal(); break;
    case "task-tab": ui.taskTab = id; render(true); break;
    case "complete-task": store.completeTask(id); toast("任务已完成，结果已回写客户360", "success"); break;
    case "customer-view": ui.customerView = id; render(true); break;
    case "new-customer": openModal({ title: "新增客户", desc: "填写已经获得授权的客户基本信息、来源渠道与负责人；创建后可在客户360继续补充真实沟通记录。", body: `<form id="customer-form"><div class="form-grid">${formField("客户姓名","name","",{required:true})}${formField("手机号","mobile","",{required:true})}${formField("来源渠道","source","官网",{type:"select",items:["官网","企业微信","电话","到院","转介绍","其他"]})}${formField("负责人","owner","",{type:"select",items:["", ...store.state.managementUsers.filter((item) => item.status === "启用").map((item) => item.name)]})}</div></form>`, footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="customer-form">创建档案</button>` }); break;
    case "segment": location.hash = "#/customers/segments"; toast("已打开动态分群，规则会随客户事件实时重算", "success"); break;
    case "edit-profile": showProfileModal(id); break;
    case "photo-consent": showPhotoModal(id); break;
    case "update-stage": showStageModal(id); break;
    case "create-customer-task": showTaskModal(id); break;
    case "send-from-customer": {
      const conv = store.state.conversations.find((item) => item.customerId === id) || store.createConversationDraft({ customerId:id, channel:"企业微信" });
      if (conv) { ui.conversationId = conv.id; location.hash = "#/conversations"; }
      else toast("未找到客户，无法创建会话草稿", "danger");
      break;
    }
    case "call": {
      const customer = store.customer(id);
      if (!customer) { toast("未找到客户，无法创建电话跟进任务", "danger"); break; }
      store.addTask({ customerId:customer.id, title:`电话跟进：${customer.name}`, type:"人工跟进", priority:"中", dueAt:new Date(Date.now() + 60 * 60 * 1000).toISOString(), assignee:customer.owner, reason:"由人工通过已授权电话渠道联系；系统不会拨打真实号码。", source:"客户360" });
      toast("电话跟进任务已创建，系统不会拨打真实号码", "success");
      break;
    }
    case "execute-nba": { const customer = store.customer(id); store.updateCustomer(id, { nextAction: { ...customer.nextAction, status: "已执行" } }, { type: "task", title: "下一步建议已执行", detail: customer.nextAction.title, actor: customer.nextAction.owner, channel: customer.nextAction.channel, tone: "positive" }); toast("动作已执行并写入时间线", "success"); break; }
    case "replace-nba": { const customer = store.customer(id); openModal({ title: "调整下一步建议", desc: "调整后保留原建议、调整原因和执行责任。", body: `<form id="nba-form" data-customer-id="${id}"><div class="form-grid">${formField("建议动作","title",customer.nextAction.title,{type:"textarea",full:true})}${formField("执行人","owner",customer.nextAction.owner)}${formField("渠道","channel",customer.nextAction.channel,{type:"select",items:["企业微信","电话","官网","线下"]})}${formField("调整原因","reason","人工结合最新沟通调整",{type:"textarea",full:true})}</div></form>`, footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="nba-form">保存新建议</button>` }); break; }
    case "nba-evidence": showEvidenceModal(id); break;
    case "timeline-filter": ui.timelineFilter = id; render(true); break;
    case "export-timeline": { const customer = store.customer(id); downloadText(`${customer.name}_客户360时间线.txt`, customer.timeline.map((item) => `${formatDate(item.occurredAt)}｜${item.title}\n${item.detail}`).join("\n\n")); toast("时间线摘要已导出（不含照片和完整手机号）", "success"); break; }
    case "reassign": showReassignModal(id); break;
    case "add-journey": showJourneyModal(id); break;
    case "consent-detail": showPhotoModal(id); break;
    case "stage-history": showEvidenceModal(id); break;
    case "select-conversation": ui.conversationId = id; conversationReads.markRead(store.conversation(id)); render(true); break;
    case "conversation-stats": location.hash = "#/conversations/quality"; break;
    case "new-conversation": showNewConversationModal(); break;
    case "conversation-filter": ui.conversationFilter = id; render(true); break;
    case "conversation-mode": {
      const conversation = store.conversation(ui.conversationId);
      const customer = conversation ? store.customer(conversation.customerId) : null;
      if (isPresalesWorkspace() && customer?.origin !== "acquisition_advisor") {
        toast("售前人员只能通过实名接管队列变更机器人状态", "warning");
        break;
      }
      if (customer?.origin === "acquisition_advisor") {
        const handover = linkedHandoverForConversation(conversation);
        if (id === "人工" && handover?.status === "pending") await claimHandoverFromUi(handover.id, target);
        else toast("售前智能体会话的接管状态必须通过实名人工队列变更", "warning");
        break;
      }
      store.setConversationMode(ui.conversationId, id);
      toast(id === "人工" ? "人工已接管，AI停止对外发送" : "已开启AI辅助，发送前仍由人工确认", "success");
      break;
    }
    case "send-message": sendCurrentMessage(id); break;
    case "handover-conversation": {
      const conversation = store.conversation(id);
      const customer = conversation ? store.customer(conversation.customerId) : null;
      const handover = conversation ? linkedHandoverForConversation(conversation) : null;
      if (customer?.origin === "acquisition_advisor") {
        closeModal();
        if (handover?.status === "pending") await claimHandoverFromUi(handover.id, target);
        else toast("请从实名人工接管队列处理该会话", "warning");
        break;
      }
      store.setConversationMode(id,"人工"); closeModal(); toast("会话已转人工，AI停止对外发送", "success"); break;
    }
    case "insert-template": {
      const template = commonPhraseRecords().find((item) => item.presalesInsertable !== false);
      const input = document.querySelector("#message-input");
      if (!template || !input) { toast("暂无已启用的话术模板", "warning"); break; }
      input.value = template.content;
      input.focus();
      toast(`已插入话术模板：${template.name}`, "success");
      break;
    }
    case "open-phrase-library": location.hash = "#/conversations/templates"; break;
    case "use-common-phrase": {
      const template = commonPhraseRecords().find((item) => item.id === id);
      if (!template) { toast("该话术已停用或不存在，请刷新页面", "warning"); break; }
      if (template.presalesInsertable === false) { toast("该话术仅供查看，不能插入会话", "warning"); break; }
      const input = document.querySelector("#message-input");
      if (input) {
        input.value = input.value ? `${input.value}\n${template.content}` : template.content;
        input.focus();
        toast(`已插入常用话术：${template.name}`, "success");
        break;
      }
      try {
        await navigator.clipboard.writeText(template.content);
        toast(`已复制常用话术：${template.name}；请在已批准渠道中由人工确认发送`, "success");
      } catch {
        toast("当前会话未开放文本输入，且浏览器未授权复制；请从常用话术库查看内容", "warning");
      }
      break;
    }
    case "insert-knowledge": {
      const knowledge = (store.state.knowledge || []).find((item) => item.status === "已发布" && item.customerFacing !== false && item.allowedForCustomerResponse !== false && item.excerpt);
      const input = document.querySelector("#message-input");
      if (!knowledge || !input) { toast("暂无可用于客户回答的已发布知识", "warning"); break; }
      input.value = `【已发布知识：${knowledge.title}】${knowledge.excerpt}`;
      input.focus();
      toast(`已引用知识：${knowledge.title}`, "success");
      break;
    }
    case "edit-journey": location.hash = `#/journey/${id}`; break;
    case "back-journeys": location.hash = "#/journeys"; break;
    case "toggle-journey": store.toggleJourney(id); toast("旅程状态已更新，客户进度和操作记录均已保留", "success"); break;
    case "publish-journey": { const journey = store.state.journeys.find((item) => item.id === id); openModal({ title: "提交旅程发布", desc: `${journey.name} · ${journey.version}`, body: `<div class="stack">${["授权与频控检查通过","医疗边界与异常分支已配置","测试客户运行通过","审批责任人：运营负责人 + 合规"].map((item) => `<div class="row">${icon("check",16)}${item}</div>`).join("")}<div class="risk-banner">${icon("alert",14)}发布将生成新版本；已运行版本不被覆盖。</div></div>`, footer: `<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="confirm-publish-journey" data-id="${id}">确认发布</button>` }); break; }
    case "confirm-publish-journey": store.publishJourney(id); closeModal(); render(true); toast("旅程已发布并开始运行", "success"); break;
    case "select-journey-node": selectJourneyCanvasNode(id); break;
    case "add-node": addJourneyCanvasNode(id); break;
    case "delete-journey-node": deleteJourneyCanvasNode(id); break;
    case "canvas-zoom": {
      const journey = activeJourneyCanvas();
      if (journey) {
        ui.journeyCanvasZoom[journey.id] = Math.min(1.2, Math.max(.8, (Number(ui.journeyCanvasZoom[journey.id]) || 1) + Number(id || 0)));
        render(true);
      }
      break;
    }
    case "test-journey": validateJourneyCanvas(id); break;
    case "save-journey": saveJourneyCanvas(id); break;
    case "new-journey": showNewJourneyModal(); break;
    case "journey-review": location.hash = "#/journeys/review"; break;
    case "journey-instances": location.hash = "#/journeys/instances"; break;
    case "toggle-agent": {
      const agent = (store.state.agents || []).find((item) => item.id === id);
      if (!agent) { toast("未找到该智能体档案，请刷新后重试", "warning"); break; }
      const updated = store.toggleAgent(id);
      if (!updated) {
        toast(isMandatoryAgent(agent) ? "系统强制合规守门员不可停用" : "智能体状态未改变，请刷新后重试", "warning");
        break;
      }
      render(true);
      toast(updated.status === "已停用" ? "智能体已停用；新的工作将交由人工或其他已启用岗位处理" : `智能体状态已更新为${updated.status}`, "success");
      break;
    }
    case "agent-detail": location.hash = `#/agent/${id}`; break;
    case "agent-api": location.hash = "#/agents/api"; break;
    case "run-eval": showUnavailableManagementAction(action, target); break;
    case "agent-evals": location.hash = "#/agents/evaluations"; break;
    case "api-run-test": runAgentApiConsole(false, target); break;
    case "api-use-router": runAgentApiConsole(true, target); break;
    case "copy-api-curl": copyApiCurl(); break;
    case "new-agent": showAgentMaintenanceModal(); break;
    case "edit-agent": showAgentMaintenanceModal(id); break;
    case "delete-agent": showDeleteAgentModal(id); break;
    case "confirm-delete-agent": {
      const agent = (store.state.agents || []).find((item) => item.id === id);
      const deleted = store.deleteAgent(id);
      closeModal();
      if (!deleted) {
        const message = isMandatoryAgent(agent)
          ? "系统强制合规守门员不可删除"
          : "智能体仍有关联客户或记录已变更；请先完成责任链转交后再删除";
        toast(message, "warning");
        break;
      }
      if (location.hash === `#/agent/${id}`) location.hash = "#/agents";
      else render(true);
      toast(`智能体 ${agent?.name || id} 已删除，历史审计记录已保留`, "success");
      break;
    }
    case "new-physician": showPhysicianModal(); break;
    case "edit-physician": showPhysicianModal(id); break;
    case "physician-avatar": {
      const physician = store.physician(id);
      if (!physician) return toast("未找到该医师，无法打开AI分身工作室", "danger");
      location.hash = avatarStudioHash(physician.id);
      break;
    }
    case "avatar-refresh": ui.avatarHydratedAt = 0; hydrateAvatarStudio(true, { background:true }); break;
    case "avatar-refresh-job": hydrateAvatarStudio(true, { background:true }); break;
    case "avatar-view-job": openAvatarJobDetail(id, target); break;
    case "avatar-detail-refresh": openAvatarJobDetail(id, target); break;
    case "avatar-open-video": openAvatarVideo(id); break;
    case "avatar-cancel-job": cancelAvatarJob(id); break;
    case "avatar-cancel-job-detail": cancelAvatarJob(id, true); break;
    case "avatar-delete-job": showDeleteAvatarJobModal(id); break;
    case "avatar-confirm-delete": deleteAvatarJob(id, target); break;
    case "delete-physician": showDeletePhysicianModal(id); break;
    case "confirm-delete-physician": {
      const deleted = store.deletePhysician(id);
      closeModal();
      if (location.hash === `#/physician/${id}`) location.hash = "#/physicians";
      toast(deleted ? "医师档案已删除，操作记录已保存" : "未找到该医师档案", deleted ? "success" : "danger");
      break;
    }
    case "knowledge-tab": {
      ui.knowledgeTab = id;
      ui.knowledgePage = 1;
      render(true);
      if (id === "准入与发布") hydrateKnowledgeGovernance();
      break;
    }
    case "refresh-knowledge-governance": await hydrateKnowledgeGovernance({ force:true, announce:true }); break;
    case "refresh-knowledge-intake": await hydrateKnowledgeIntake({ force:true, announce:true }); break;
    case "clear-knowledge-intake-filters":
      clearKnowledgeIntakeFilterState();
      await hydrateKnowledgeIntake({ force:true });
      break;
    case "new-knowledge-intake": showKnowledgeIntakeModal(); break;
    case "edit-knowledge-intake": await showKnowledgeMaintenanceModal(id, "edit"); break;
    case "confirm-knowledge-intake": await showKnowledgeMaintenanceModal(id, "confirmation"); break;
    case "candidate-knowledge-intake": await showKnowledgeMaintenanceModal(id, "candidate"); break;
    case "knowledge-conflict-reload": {
      const conflictState = ui.knowledgeVersionConflict;
      ui.knowledgeVersionConflict = null;
      if (conflictState) await showKnowledgeMaintenanceModal(conflictState.document.id, conflictState.action);
      else closeModal();
      break;
    }
    case "knowledge-conflict-retry": await retryKnowledgeVersionConflict(target); break;
    case "knowledge-page": {
      ui.knowledgePage = Math.max(1, Number(id) || 1);
      render(true);
      requestAnimationFrame(() => document.querySelector(".knowledge-result-meta")?.scrollIntoView({ block:"start", behavior:"smooth" }));
      break;
    }
    case "knowledge-detail": location.hash = `#/knowledge-item/${id}`; break;
    case "approve-knowledge": showKnowledgeApproval(id); break;
    case "submit-knowledge-review": store.updateKnowledge(id,"待医务审核"); closeModal(); toast("已提交医务初审，审核通过前不会用于正式回答", "success"); break;
    case "confirm-medical-knowledge": store.updateKnowledge(id,"待合规审核"); closeModal(); toast("医务审核已通过，等待合规终审", "success"); break;
    case "confirm-knowledge": store.updateKnowledge(id,"已发布"); closeModal(); toast("知识已发布，AI员工可在授权范围内用于正式回答", "success"); break;
    case "reject-knowledge": store.updateKnowledge(id,"退回修改"); closeModal(); toast("知识已退回，修改完成并重新审核前不会用于正式回答", "warning"); break;
    case "unpublish-knowledge": store.updateKnowledge(id,"已下架"); toast("知识已下架，关联回答与旅程内容已冻结", "warning"); break;
    case "rule-test": location.hash = "#/agents/api"; toast("请在本地调用测试台选择合规守门员，执行真实内容检查", "success"); break;
    case "new-knowledge": showNewKnowledgeModal(); break;
    case "new-management-user": showManagementUserModal(); break;
    case "edit-management-user": showManagementUserModal(id); break;
    case "toggle-management-user": {
      const user = (store.state.managementUsers || []).find((item) => item.id === id);
      if (!user) { toast("未找到该后台用户", "warning"); break; }
      const updated = store.updateManagementUser(id, { ...user, status:user.status === "启用" ? "停用" : "启用" });
      toast(`用户 ${updated.name} 已${updated.status}`, "success");
      break;
    }
    case "new-management-role":
    case "edit-management-role":
      toast("一期角色固定为管理员和售前人员，暂不支持新增、编辑或删除角色", "warning");
      break;
    case "view-audit": showAuditRecordModal(id); break;
    case "new-message-template": showConfigurationRecordModal("message_template"); break;
    case "edit-message-template": showConfigurationRecordModal("message_template", id); break;
    case "new-journey-template": showConfigurationRecordModal("journey_template"); break;
    case "edit-journey-template": showConfigurationRecordModal("journey_template", id); break;
    case "use-journey-template": {
      const template = (store.state.configurationRecords || []).find((item) => item.id === id && item.kind === "journey_template");
      if (!template) { toast("未找到该旅程模板", "warning"); break; }
      if (template.status !== "启用") { toast("请先启用并复核该模板，再创建旅程草稿", "warning"); break; }
      const nodes = Array.isArray(template.nodes) ? template.nodes.map((item) => String(item || "").trim()).filter(Boolean) : [];
      if (nodes.length < 2) { toast("模板至少需要两个有效步骤", "warning"); break; }
      const journey = store.addJourney({ name:template.name, stage:template.stage || "售前", owner:template.owner || "", nodes, templateId:template.id });
      location.hash = `#/journey/${journey.id}`;
      toast("已按模板创建旅程草稿，尚未加入客户或触达客户", "success");
      break;
    }
    case "new-segment": showConfigurationRecordModal("segment"); break;
    case "edit-segment": showConfigurationRecordModal("segment", id); break;
    case "new-product": showProductModal(); break;
    case "edit-product": showProductModal(id); break;
    case "analytics-drill": ui.customerQuery = ""; ui.customerStage = id.includes("到院") || id.includes("成交") ? "售中" : "全部"; location.hash = "#/customers"; toast(`已按“${id}”下钻客户清单`, "success"); break;
    case "create-insight-task": {
      const customer = store.state.customers[0];
      if (!customer) {
        toast("暂无可关联的真实客户，请先建立客户档案后再创建改进任务", "warning");
        break;
      }
      store.addTask({ customerId: customer.id, title: "优化人工接待排班", type: "经营改进", priority: "高", dueAt: new Date(Date.now()+86400000).toISOString(), assignee: "", reason: "基于当前系统记录创建，待运营负责人补充分配依据", source: "数据洞察" });
      toast("改进任务已保存到本地服务", "success");
      break;
    }
    case "export-report": {
      const metrics = managementOverviewMetrics();
      const countByStage = (stage) => metrics.countStage(stage);
      const lines = [
        "时代之美经营分析摘要（当前本地系统口径）",
        `生成时间：${new Date().toLocaleString("zh-CN")}`,
        "",
        `已建档客户：${metrics.customers.length}`,
        `售前客户：${countByStage("售前")}`,
        `售中客户：${countByStage("售中")}`,
        `售后客户：${countByStage("售后")}`,
        `当前会话：${metrics.conversations.length}`,
        `未完成任务：${metrics.openTasks.length}`,
        `超时任务：${metrics.overdueTasks.length}`,
        "",
        "说明：一期当前为独立本地系统。交易、到院、外部渠道和实时预约数据尚未接入，本报告不以演示数字替代。"
      ];
      downloadText("时代之美_经营分析摘要.txt", lines.join("\n"));
      toast("已导出当前系统口径的经营摘要", "success");
      break;
    }
    case "settings-tab": {
      const settingsRoutes = { "连接器":"", "本地数据服务":"", "组织与人员":"organization", "权限与审计":"permissions" };
      if (Object.hasOwn(settingsRoutes, id)) location.hash = `#/integrations${settingsRoutes[id] ? `/${settingsRoutes[id]}` : ""}`;
      else { ui.settingsTab = id; render(); }
      break;
    }
    case "test-connector": {
      const result = store.testConnector(id);
      toast(result.message || "配置检查完成", result.ok ? "success" : "warning");
      break;
    }
    case "new-connector": showNewConnectorModal(); break;
    case "field-map": showFieldMapModal(id); break;
    case "connector-more": location.hash = `#/connector/${id}`; break;
    case "integration-log": location.hash = "#/integrations"; break;
    case "save-mapping": showUnavailableManagementAction(action, target); break;
    case "save-settings": showUnavailableManagementAction(action, target); break;
    case "journey-more": location.hash = `#/journey/${id}`; break;
    case "approval-preview":
    case "approval-pass":
    case "duplicate-compare":
    case "duplicate-merge":
    case "template-preview":
    case "template-copy":
    case "template-new":
    case "journey-optimize":
    case "log-detail":
    case "rule-detail":
    case "audit-detail":
    case "mapping-detail":
    case "new-mapping":
    case "new-member":
    case "stage-config":
    case "project-new":
    case "role-detail":
    case "version-detail":
    case "knowledge-source":
    case "knowledge-version":
    case "connector-events":
    case "segment-edit":
    case "segment-activate": showUnavailableManagementAction(action, target); break;
    case "notifications": {
      const handovers = (store.state.handovers || [])
        .filter((item) => ["pending", "claimed", "active"].includes(item.status))
        .sort((left, right) => {
          const priority = Number(right.priority === "urgent") - Number(left.priority === "urgent");
          return priority || Date.parse(left.sla_due_at || 0) - Date.parse(right.sla_due_at || 0);
        });
      openModal({
        title:"通知中心",
        desc:"来自售前智能体服务的实时人工接管任务",
        body:handovers.length
          ? `<div class="stack">${handovers.slice(0, 20).map((handover) => `<div class="responsibility-row"><span class="responsibility-icon">${icon(handover.priority === "urgent" ? "alert" : "clock",15)}</span><div><strong style="font-size:11px">${escapeHtml(handoverReasonLabel(handover.reason))}</strong><div class="caption">${escapeHtml(handover.channel || "未知渠道")} · ${handover.status === "pending" ? "待接管" : `接管人 ${escapeHtml(handover.assignee || "待确认")}`} · SLA ${handover.sla_due_at ? escapeHtml(formatDate(handover.sla_due_at)) : "待确认"}</div></div></div>`).join("")}</div>`
          : empty("当前没有实时接管通知", "此处不展示硬编码示例；新任务会在页面可见时自动出现"),
        footer:`<button class="btn" data-action="refresh-handovers">刷新队列</button><button class="btn primary" data-action="modal-close">知道了</button>`
      });
      break;
    }
    default:
      if (action) toast("该入口尚未接入可执行服务，本次未执行任何变更", "warning");
  }
}

async function claimHandoverFromUi(handoverId, trigger) {
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.textContent = "正在接管…"; }
  try {
    const handover = await claimManagementHandover(handoverId);
    store.updateAcquisitionHandover(handover);
    toast("已实名接管，该会话的AI对外发送已停止", "success");
  } catch (error) {
    const message = error.status === 401
      ? "请先完成企业实名登录"
      : error.status === 403
        ? "当前账号没有人工接管权限"
        : error.status === 409
          ? "该任务已被其他顾问接管或已完结"
          : "人工接管失败，请稍后重试";
    toast(message, "danger");
    await syncAcquisitionHandovers(true);
  } finally {
    if (trigger?.isConnected) { trigger.disabled = false; trigger.innerHTML = original; }
  }
}

let contactRevealHideTimer = null;
let contactRevealCountdownTimer = null;

function clearRevealedContact({ markHidden = true } = {}) {
  if (contactRevealHideTimer) clearTimeout(contactRevealHideTimer);
  if (contactRevealCountdownTimer) clearInterval(contactRevealCountdownTimer);
  contactRevealHideTimer = null;
  contactRevealCountdownTimer = null;
  const valueNode = document.querySelector("[data-contact-reveal-value]");
  if (valueNode) {
    valueNode.textContent = markHidden ? "已自动隐藏" : "";
    valueNode.removeAttribute("data-contact-reveal-value");
  }
  const countdownNode = document.querySelector("[data-contact-reveal-countdown]");
  if (countdownNode) countdownNode.textContent = markHidden ? "联系方式已从页面清除" : "";
}

function showOneTimeContact(contact) {
  const mobile = String(contact?.value || "");
  if (!/^1[3-9]\d{9}$/.test(mobile)
      || contact?.purpose !== "service_callback"
      || contact?.browser_storage_allowed !== false) {
    const error = new Error("联系方式服务返回了无效披露结果");
    error.code = "CONTACT_REVEAL_RESPONSE_INVALID";
    error.status = 503;
    throw error;
  }
  clearRevealedContact({ markHidden:false });
  openModal({
    title:"一次性查看联系方式",
    desc:"仅限当前领取顾问用于本次服务回访，不得复制到个人设备或未批准渠道。",
    body:`<div class="card padded"><div class="caption">客户已留手机号（待人工回电核号）</div><div class="identity-title" style="margin-top:8px"><strong data-contact-reveal-value>${escapeHtml(mobile)}</strong></div><div class="caption" data-contact-reveal-countdown style="margin-top:8px">30秒后自动隐藏</div></div><div class="guardrail">${icon("shield",14)}本次查看已审计；号码不会写入浏览器存储、普通客户列表、日志或通知。</div>`,
    footer:`<button class="btn primary" data-action="modal-close">已完成查看</button>`
  });
  // Drop the response object's plaintext reference immediately after the DOM
  // disclosure is created. The DOM value is also removed after 30 seconds.
  contact.value = "";
  let seconds = 30;
  contactRevealCountdownTimer = window.setInterval(() => {
    seconds -= 1;
    const countdownNode = document.querySelector("[data-contact-reveal-countdown]");
    if (countdownNode && seconds > 0) countdownNode.textContent = `${seconds}秒后自动隐藏`;
  }, 1_000);
  contactRevealHideTimer = window.setTimeout(() => clearRevealedContact(), 30_000);
}

async function revealHandoverContactFromUi(handoverId, trigger, { appointment = false } = {}) {
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.textContent = "正在核验权限…"; }
  try {
    const contact = await (appointment ? revealManagementAppointmentContact(handoverId) : revealManagementHandoverContact(handoverId));
    showOneTimeContact(contact);
  } catch (error) {
    const message = error.status === 401
      ? "请先完成企业实名登录"
      : error.code === "CONTACT_REVEAL_HANDOVER_NOT_CLAIMED"
        ? "请先实名接管该会话"
        : error.code === "CONTACT_REVEAL_ASSIGNEE_MISMATCH" || error.status === 403
          ? "只有当前实名接管顾问可以查看联系方式"
          : ["CONTACT_REVEAL_SERVICE_CONSENT_REQUIRED", "CONTACT_REVEAL_SUPPRESSED"].includes(error.code)
            ? "客户已撤回或限制本次服务联系，号码未披露"
            : error.code === "CONTACT_REVEAL_UNAVAILABLE"
              ? "客户尚无可用的联系方式"
              : "联系方式保险库暂时不可用，请稍后重试";
    toast(message, error.status === 401 || error.status === 409 ? "warning" : "danger");
  } finally {
    if (trigger?.isConnected) { trigger.disabled = false; trigger.innerHTML = original; }
  }
}

function showCompleteHandoverModal(handoverId, { resumeRobot = false } = {}) {
  const handover = store.handover(handoverId);
  if (!handover) return toast("未找到该接管任务，请刷新队列", "warning");
  openModal({
    title:resumeRobot ? "确认机器人接管" : "完结人工接管",
    desc:`${handoverReasonLabel(handover.reason)} · ${handover.channel || "未知渠道"}`,
    body:`<form id="handover-complete-form" data-handover-id="${handover.id}" data-resume-robot="${resumeRobot ? "true" : "false"}"><div class="form-grid">${formField("处理结果","resolution","已完成人工回访并明确下一步",{type:"textarea",full:true,required:true})}${formField("实际付出时间（分钟）","minutes","5",{type:"number",required:true})}${formField("工时备注","notes","电话或已批准渠道人工跟进",{type:"textarea",full:true})}</div><div class="guardrail">${icon("shield",14)}${resumeRobot ? "确认后将关闭本次人工接管，机器人只会在已批准的知识、权限和风险规则内处理后续新消息；不恢复任何未获批准的外部发送。" : "完结后AI可恢复处理后续新消息；操作人和工时由企业实名身份记录，页面不能代填。"}</div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="handover-complete-form">${resumeRobot ? "确认机器人接管并登记" : "确认完结并登记"}</button>`
  });
}

async function claimAppointmentFromUi(intakeId, trigger) {
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.textContent = "正在领取…"; }
  try {
    const intake = await claimManagementAppointmentIntake(intakeId);
    const index = ui.appointmentIntakes.findIndex((item) => item.id === intake.id);
    if (index < 0) ui.appointmentIntakes.unshift(intake);
    else ui.appointmentIntakes[index] = intake;
    toast("到院登记已领取，请回电核号并记录跟进结果", "success");
    render(true);
  } catch (error) {
    toast(error.status === 403 ? "当前账号没有预约处理权限" : error.status === 409 ? "该预约已由其他人员处理，请刷新队列" : "领取预约事项失败，请稍后重试", "danger");
    await syncAppointmentOperations();
  } finally {
    if (trigger?.isConnected) { trigger.disabled = false; trigger.innerHTML = original; }
  }
}

async function showResolveAppointmentModal(intakeId) {
  const intake = (ui.appointmentIntakes || []).find((item) => item.id === intakeId);
  if (!intake) return toast("未找到登记，请刷新队列", "warning");
  openModal({ title:"记录到院登记跟进", desc:`${(intake.projects || []).join("、")} · ${intake.time_preference}`,
    body:`<form id="appointment-resolve-form" data-appointment-intake-id="${intake.id}"><div class="form-grid">
      ${formField("跟进结果","status","completed",{type:"select",items:[{ value:"completed", label:"已完成本次跟进" }, { value:"needs_customer_info", label:"待客户补充信息" }]})}
      ${formField("跟进说明","note","",{type:"textarea",full:true,required:true})}
    </div><div class="guardrail">客户已确认到院时间。此处只记录跟进结果；修改时间或取消登记需由客户明确确认。</div></form>`,
    footer:`<button class="btn" data-action="modal-close">返回</button><button class="btn primary" type="submit" form="appointment-resolve-form">保存跟进结果</button>` });
}

function showKnowledgeIntakeModal() {
  if (!knowledgeIntakeEnabled) return toast("知识录入服务尚未启用", "warning");
  openModal({
    title:"上传原始知识素材",
    desc:"素材先隔离保存并计算文件指纹，解析后建立内部草稿。对客使用须补齐来源、有效期、院方确认和正式发布。",
    body:`<form id="knowledge-intake-form"><div class="form-grid">
      <label class="form-group full"><span class="form-label">选择原始素材</span><input class="form-control" type="file" name="source_file" accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,.jpg,.jpeg,.png,.webp,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/webp" required /><small class="caption">支持 TXT、Markdown、CSV、JSON、PDF、DOCX、JPG、PNG、WEBP。文本单个不超过 256KB；JPG/PNG/WEBP 单个不超过 16MB；PDF/DOCX 单个不超过 32MB。内容类型仅限下方列出的选项，服务端会再次校验格式、MIME、大小和内容类型。</small></label>
      ${formField("所属科室","department","",{required:true})}
      ${formField("内容类型","content_type","项目介绍",{type:"select",items:["项目介绍","医生介绍","服务流程","活动权益","公开海报","排班说明","其他"]})}
      ${formField("内容负责人","owner","",{required:true})}
      ${formField("标签（用逗号分隔）","tags","",{full:true})}
      <div class="form-group full"><span class="form-label">问答范围</span><label class="lead-consent"><input type="checkbox" name="customer_facing_candidate" /><span>计划申请用于对客问答。勾选仅登记用途，不会直接对客发布。</span></label></div>
    </div><div class="guardrail">${icon("shield",14)}系统会记录实名操作人、文件指纹、解析状态和索引版本；浏览器不会保存原文。原始文件、草稿与候选资料均不直接进入对客问答。</div></form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="knowledge-intake-form">上传并受控解析</button>`
  });
}

const localKnowledgeDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16) : "";
};
// 详情弹窗与列表必须给出一致的发布状态：不能再写死“尚未对客发布”。
function publicationStatusLabel(knowledgeDocument) {
  const status = summarizeDocumentPublicationStatus({ document:knowledgeDocument, publications:ui.publications });
  return status.package_id ? `${status.label}（包 ${status.package_id}）` : status.label;
}

async function showKnowledgeMaintenanceModal(id, action) {
  try {
    const document = await getManagementKnowledgeIntakeDocument(id);
    const missing = (document.publication_readiness?.missing || []).map((key) => knowledgeMissingLabels[key] || key).join("、");
    const confirmation = document.hospital_confirmation;
    const confirmationSummary = confirmation ? `<div class="card padded" style="margin:12px 0"><strong>当前确认凭据 · v${Number(confirmation.version)}</strong><p>${escapeHtml(confirmation.reference)}</p><div class="caption">院方确认人：${escapeHtml(confirmation.confirmed_by)} · 登记人：${escapeHtml(confirmation.recorded_by)}<br>确认时间：${formatDate(confirmation.confirmed_at)} · 有效截止：${formatDate(confirmation.expires_at)}</div></div>` : `<p class="caption">当前版本尚无院方确认凭据。</p>`;
    const versionHistory = (document.version_history || []).length
      ? `<div class="card padded" style="margin:12px 0"><strong>版本变更</strong><div class="stack" style="margin-top:8px;gap:7px">${document.version_history.slice().reverse().map((item) => {
        const changes = (item.changed_fields_to_next || []).map((field) => knowledgeVersionChangeLabels[field] || field);
        return `<div class="row between"><span>v${Number(item.version)} → v${Number(item.version) + 1}</span><span class="caption">${escapeHtml(changes.join("、") || "未检测到业务字段变化")}</span></div>`;
      }).join("")}</div></div>`
      : `<div class="caption" style="margin:10px 0">当前是首个版本，暂无历史差异。</div>`;
    const correctionHistory = (document.correction_history || []).length
      ? `<section class="card padded" style="margin:12px 0"><strong>人工校订记录</strong><p class="caption" style="margin:6px 0 10px">以下原文快照、来源与操作记录仅对当前授权人员展示，不代表对客发布。</p><div class="stack" style="gap:10px">${document.correction_history.slice().reverse().map((item) => {
        const source = item.original_source || {};
        return `<details><summary><strong>v${Number(item.from_version)} → v${Number(item.to_version)}</strong><span class="caption"> · 校订人：${escapeHtml(item.corrected_by || "未知")} · ${escapeHtml(formatDate(item.corrected_at))}</span></summary><div class="caption" style="margin-top:8px">原始文件：${escapeHtml(source.source_filename || "未命名素材")}<br/>原始文件指纹：${escapeHtml(source.source_sha256 || "未记录")}<br/>原始素材编号：${escapeHtml(source.source_asset_id || "无")}${source.source_reference ? `<br/>来源凭据：${escapeHtml(source.source_reference)}` : ""}<br/>正文指纹：${escapeHtml(item.original_content_hash || "未记录")} → ${escapeHtml(item.corrected_content_hash || "未记录")}</div><details style="margin-top:8px"><summary>查看原文快照</summary><div class="caption" style="white-space:pre-wrap;max-height:240px;overflow:auto;margin-top:8px">${escapeHtml(item.original_text || "（原文为空）")}</div></details></details>`;
      }).join("")}</div></section>`
      : `<div class="caption" style="margin:10px 0">尚无人工校订记录。</div>`;
    const parseIssues = Array.isArray(document.parse_quality?.issues) ? document.parse_quality.issues : [];
    const parseQuality = document.parse_quality?.status === "needs_attention"
      ? `<div class="risk-banner" style="margin:10px 0">${icon("alert",14)}<div><strong>解析待处理</strong><br/>${parseIssues.map((issue) => `${escapeHtml(issue.locator || "来源未知")}：${escapeHtml(issue.message || issue.code || "需要人工核对")}`).join("<br/>")}</div></div>`
      : `<div class="caption" style="margin:10px 0">解析质量检查通过；预览仅限当前授权人员核对。</div>`;
    const parsePreview = Array.isArray(document.parse_preview) && document.parse_preview.length
      ? `<section class="card padded" style="margin:12px 0"><strong>解析预览与来源定位</strong><p class="caption" style="margin:6px 0 10px">原文件：${escapeHtml(document.source_filename || "未命名素材")}。以下预览仅限当前授权人员核对，不代表对客发布。</p>${parseQuality}<div class="stack" style="gap:8px">${document.parse_preview.map((segment) => `<details><summary><strong>${escapeHtml(segment.locator || `段落 ${segment.paragraph || "—"}`)}</strong>${segment.issue_codes?.length ? ` ${badge("待处理", "warning")}` : ""}<span class="caption"> · ${escapeHtml(segment.source_filename || document.source_filename || "未命名素材")}</span></summary><div class="caption" style="white-space:pre-wrap;margin-top:8px">${escapeHtml(segment.content || "（空段落）")}</div></details>`).join("")}</div></section>`
      : `<div class="risk-banner" style="margin:12px 0">${icon("alert",14)}当前资料尚未产生可预览的解析源段；请等待受控解析完成，系统不会伪造正文、段落或页码。</div>`;
    const fields = action === "edit" ? `
      ${formField("标题", "title", document.title, { required:true, full:true })}
      ${formField("校订正文", "text_content", document.text_content, { type:"textarea", required:true, full:true })}
      ${formField("来源凭据（文件编号或受控链接）", "source_reference", document.source_reference || "", { full:true })}
      ${formField("适用院区（逗号分隔）", "applicable_campuses", (document.applicable_campuses || []).join("，"), { full:true })}
      ${formField("公开用途", "public_scope", document.public_scope || "internal", { type:"select", items:[{value:"internal",label:"仅内部"},{value:"customer_summary",label:"拟对客摘要"},{value:"public_full",label:"拟公开全文"}] })}
      ${formField("生效日期", "effective_at", localKnowledgeDate(document.effective_at), { type:"datetime-local" })}
      ${formField("失效日期", "expires_at", localKnowledgeDate(document.expires_at), { type:"datetime-local" })}` : action === "confirmation" ? `
      ${formField("院方确认人", "confirmed_by", "", { required:true })}
      ${formField("确认凭据（编号或受控链接）", "reference", "", { required:true, full:true })}
      ${formField("确认时间", "confirmed_at", "", { type:"datetime-local", required:true })}
      ${formField("确认有效截止", "confirmation_expires_at", "", { type:"datetime-local", required:true })}` : `<p class="page-desc">候选仅固定当前版本供后续评测准备，不会改变对客知识源。${missing ? `尚缺：${escapeHtml(missing)}` : "来源、院区、用途、有效期与本版本院方确认已齐备。"}</p>`;
    openModal({ title:action === "edit" ? "查看与校订资料" : action === "confirmation" ? "登记院方线下确认" : "准备发布候选",
      desc:`${document.title} · 当前 v${document.version} · ${publicationStatusLabel(document)}`,
      body:`<form id="knowledge-maintenance-form" data-document-id="${escapeHtml(id)}" data-version="${Number(document.version)}" data-operation="${action}"><div class="form-grid">${fields}</div>${parsePreview}${confirmationSummary}${versionHistory}${correctionHistory}<div class="guardrail">${action === "edit" ? "保存将形成新版本并使原确认失效；原始文件指纹与历史版本保留。" : "线下凭据仅覆盖当前版本，由当前登录人员实名登记；仍需正式评测和发布。"}</div><div class="caption">正文指纹：${escapeHtml(document.content_hash)}</div></form>`,
      footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" type="submit" form="knowledge-maintenance-form" ${action === "candidate" && !document.publication_readiness?.ready ? "disabled" : ""}>${action === "edit" ? "保存新版本" : action === "confirmation" ? "保存确认记录" : "准备候选"}</button>` });
  } catch (error) { toast(error.message || "资料读取失败", "danger"); }
}

function showKnowledgeVersionConflictModal({ document, action, payload }) {
  const previousVersion = Number(payload.expected_version) || 0;
  ui.knowledgeVersionConflict = { document, action, payload:{ ...payload }, previousVersion };
  const localContent = String(payload.text_content || "").trim();
  const latestContent = String(document.text_content || "").trim();
  openModal({
    title:"发现并发修改",
    desc:`你基于 v${previousVersion} 的修改与服务端当前 v${document.version} 不一致；本次修改尚未写入。`,
    body:`<div class="risk-banner">${icon("alert", 16)}请先比较两份内容。选择“加载最新版本”会放弃本次未保存修改；选择“基于最新版本重试保存”会创建后续新版本，不会原地覆盖现有版本。</div>
      <div class="grid cols-2" style="margin-top:12px">
        <section class="card padded"><strong>你的待保存修改 · 基于 v${previousVersion}</strong><p class="caption" style="margin-top:8px">标题</p><p>${escapeHtml(payload.title || "（未填写）")}</p><p class="caption">正文</p><div class="caption" style="white-space:pre-wrap;max-height:180px;overflow:auto">${escapeHtml(localContent || "（未修改正文）")}</div></section>
        <section class="card padded"><strong>服务端最新版本 · v${Number(document.version)}</strong><p class="caption" style="margin-top:8px">标题</p><p>${escapeHtml(document.title || "（无标题）")}</p><p class="caption">正文</p><div class="caption" style="white-space:pre-wrap;max-height:180px;overflow:auto">${escapeHtml(latestContent || "（无正文）")}</div></section>
      </div>
      <div class="caption" style="margin-top:12px">最新版本变更：${escapeHtml((document.version_history || []).slice(-1)[0]?.changed_fields_to_next?.map((field) => knowledgeVersionChangeLabels[field] || field).join("、") || "请以服务端内容为准")}</div>`,
    footer:`<button class="btn" data-action="knowledge-conflict-reload">加载最新版本</button><button class="btn primary" data-action="knowledge-conflict-retry">基于最新版本重试保存</button>`
  });
}

async function retryKnowledgeVersionConflict(target) {
  const conflictState = ui.knowledgeVersionConflict;
  if (!conflictState) return toast("未找到待重试的资料修改，请重新打开资料", "warning");
  if (target) { target.disabled = true; target.textContent = "正在比较并保存…"; }
  try {
    const latest = await getManagementKnowledgeIntakeDocument(conflictState.document.id);
    if (Number(latest.version) !== Number(conflictState.document.version)) {
      showKnowledgeVersionConflictModal({ ...conflictState, document:latest });
      toast("资料在比较期间再次更新，请重新确认差异", "warning");
      return;
    }
    await mutateManagementKnowledgeIntakeDocument(conflictState.document.id, conflictState.action, {
      ...conflictState.payload,
      expected_version:Number(latest.version)
    });
    ui.knowledgeVersionConflict = null;
    closeModal();
    await hydrateKnowledgeIntake({ force:true });
    toast("已基于最新版本保存为后续新版本，请重新登记院方确认", "success");
  } catch (error) {
    if (error.code === "KNOWLEDGE_VERSION_CONFLICT") {
      try {
        const latest = await getManagementKnowledgeIntakeDocument(conflictState.document.id);
        showKnowledgeVersionConflictModal({ ...conflictState, document:latest });
        toast("资料再次被修改，请重新比较后决定是否重试", "warning");
        return;
      } catch { /* Preserve the original conflict for a later retry. */ }
    }
    toast(error.message || "重试保存失败，未写入任何修改", "danger");
  } finally {
    if (target?.isConnected) { target.disabled = false; target.textContent = "基于最新版本重试保存"; }
  }
}

function clearKnowledgeFieldErrors(form) {
  form.querySelectorAll("[data-knowledge-field-error]").forEach((item) => item.remove());
  form.querySelectorAll("[aria-invalid='true']").forEach((control) => {
    control.removeAttribute("aria-invalid");
    if (typeof control.setCustomValidity === "function") control.setCustomValidity("");
  });
}

function showKnowledgeFieldErrors(form, error) {
  const details = Array.isArray(error?.details) ? error.details.filter((item) => item?.field && item?.message) : [];
  if (!details.length) return false;
  clearKnowledgeFieldErrors(form);
  let firstControl = null;
  for (const detail of details) {
    const control = form.elements.namedItem(detail.field);
    if (!control || typeof control.setCustomValidity !== "function") continue;
    control.setCustomValidity(detail.message);
    control.setAttribute("aria-invalid", "true");
    const message = document.createElement("small");
    message.className = "field-error";
    message.dataset.knowledgeFieldError = "true";
    message.textContent = detail.message;
    (control.closest(".form-group") || control.parentElement)?.append(message);
    firstControl ||= control;
  }
  if (!firstControl) return false;
  firstControl.focus();
  firstControl.reportValidity();
  return true;
}

function sendCurrentMessage(conversationId) {
  const input = document.querySelector("#message-input");
  const text = input?.value.trim();
  if (!text) return toast("请输入回复内容", "warning");
  const conversation = store.conversation(conversationId);
  const customer = conversation ? store.customer(conversation.customerId) : null;
  if (customer?.origin === "acquisition_advisor") {
    return toast("本期尚未对接人工渠道发送；请使用电话或已批准渠道跟进", "warning");
  }
  if (conversation?.mode !== "人工") {
    return toast("请先切换为人工接管；当前阶段AI只能提供参考，不能对外发送消息", "warning");
  }
  const hit = riskWords.find((word) => text.includes(word));
  if (hit) {
    openModal({ title: "内容已被合规门禁拦截", desc: `命中高风险表达：“${hit}”`, body: `<div class="risk-banner">${icon("alert",16)}该内容涉及医疗边界、异常反应或效果承诺，不能由AI自动发送。请改为一般流程说明，或交由人工/医生处理。</div><div class="card padded"><div class="caption">原内容</div><p class="page-desc">${escapeHtml(text)}</p></div>`, footer: `<button class="btn" data-action="modal-close">返回修改</button><button class="btn danger" data-action="handover-conversation" data-id="${conversationId}">转人工处理</button>` });
    return;
  }
  delete ui.replyDrafts[conversationId];
  if(input)input.value="";
  store.sendMessage(conversationId, text, "人工");
  toast("人工沟通记录已保存；系统未向外部渠道发送消息", "success");
}

document.addEventListener("click", (event) => {
  const entityTarget = event.target.closest("[data-entity]");
  if (entityTarget) {
    if (handoverOnlyMode) return toast("生产模式只开放真实人工接管队列", "warning");
    location.hash = `#/${entityTarget.dataset.entity}/${entityTarget.dataset.id}`;
    return;
  }
  const customerTarget = event.target.closest("[data-customer]");
  if (customerTarget) {
    if (handoverOnlyMode) return toast("客户档案尚未接入正式服务，本次未打开演示数据", "warning");
    if (isPresalesWorkspace()) {
      const conversation = (store.state.conversations || []).find((item) => item.customerId === customerTarget.dataset.customer);
      if (!conversation) return toast("该客户当前不在可接待会话队列中", "warning");
      ui.conversationId = conversation.id;
      location.hash = "#/conversations";
      return;
    }
    location.hash = `#/customer/${customerTarget.dataset.customer}`;
    return;
  }
  const navTarget = event.target.closest("[data-nav]");
  if (navTarget) {
    if (handoverOnlyMode && navTarget.dataset.nav !== "workbench" && !((knowledgeGovernanceEnabled || knowledgeIntakeEnabled) && navTarget.dataset.nav === "knowledge")) return toast("该模块尚未接入正式服务", "warning");
    if (!handoverOnlyMode && !canOpenRouteInCurrentRole(navTarget.dataset.nav)) return toast("售前人员仅可访问客户与会话工作台", "warning");
    if (navTarget.dataset.nav === "journeys") ui.journeyView = "list";
    location.hash = `#/${navTarget.dataset.nav}`;
    return;
  }
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  if (actionTarget.dataset.action === "modal-backdrop" && event.target !== actionTarget) return;
  handleAction(actionTarget.dataset.action, actionTarget.dataset.id || "", actionTarget);
});

document.addEventListener("loadedmetadata", (event) => {
  if (event.target.matches?.("[data-avatar-video]")) syncAvatarVideoRatio(event.target);
}, true);

function filterReceptionList() {
  let visible=0;
  document.querySelectorAll('.reception-group').forEach(group=>{let count=0;group.querySelectorAll('[data-search]').forEach(item=>{item.hidden=!item.dataset.search.includes(ui.conversationQuery.trim().toLowerCase());if(!item.hidden){count++;visible++;}});group.hidden=!count;});
  const empty=document.querySelector('#reception-empty');if(empty)empty.hidden=Boolean(visible);
}
document.addEventListener("input", (event) => {
  if (isGuardedFormTarget(event.target)) markUnsavedFormDirty(true);
  if(event.target.id==='reception-search'){ui.conversationQuery=event.target.value;filterReceptionList();}
  if(event.target.id==='reception-phrase-search'){let count=0;document.querySelectorAll('[data-phrase-search]').forEach(item=>{item.hidden=!item.dataset.phraseSearch.includes(event.target.value.trim().toLowerCase());if(!item.hidden)count++;});document.querySelectorAll('.reception-phrases details').forEach(group=>{group.hidden=![...group.querySelectorAll('[data-phrase-search]')].some(item=>!item.hidden);});const empty=document.querySelector('#reception-phrase-empty');if(empty)empty.hidden=Boolean(count);}

  if (event.target.id === "global-search") {
    const query = event.target.value.trim().toLowerCase();
    const results = document.querySelector("#global-results");
    const matches = query ? store.state.customers.filter((customer) => [customer.name,customer.mobile,customer.id,...customer.tags].join(" ").toLowerCase().includes(query)).slice(0,5) : [];
    results.classList.toggle("open", Boolean(query));
    results.innerHTML = matches.length ? matches.map((customer) => `<button class="search-result" data-customer="${customer.id}">${avatar(customer,"sm")}<div><strong>${customer.name}</strong><div class="search-result-meta">档案编号 ${customer.id} · ${customer.macroStage}/${customer.microStage}</div></div></button>`).join("") : empty("未找到客户", "可尝试姓名、手机号或档案编号");
  }
  if (event.target.id === "customer-search") { ui.customerQuery = event.target.value; clearTimeout(window.__customerSearchTimer); window.__customerSearchTimer = setTimeout(() => render(true), 180); }
  if (event.target.id === "knowledge-search") { ui.knowledgeQuery = event.target.value; ui.knowledgePage = 1; clearTimeout(window.__knowledgeSearchTimer); window.__knowledgeSearchTimer = setTimeout(() => render(true), 180); }
  if (event.target.id === "knowledge-intake-search") {
    ui.knowledgeIntakeQuery = event.target.value;
    persistKnowledgeIntakeFilterState();
    clearTimeout(window.__knowledgeIntakeSearchTimer);
    window.__knowledgeIntakeSearchTimer = setTimeout(() => void hydrateKnowledgeIntake({ force:true }), 220);
  }
  if (event.target.id === "physician-search") { ui.physicianQuery = event.target.value; clearTimeout(window.__physicianSearchTimer); window.__physicianSearchTimer = setTimeout(() => render(true), 180); }
  // 话术模板内容变化时即时刷新预览：预览始终保留变量占位符，不替换客户数据。
  if (event.target.name === "content" && event.target.closest("#configuration-record-form")?.dataset.kind === "message_template") {
    const preview = document.querySelector("#message-template-preview");
    if (preview) preview.textContent = renderTemplatePreview(event.target.value);
  }
  const avatarDraft = routeAvatarPhysician() ? avatarDraftFor(routeAvatarPhysician()) : null;
  if (event.target.id === "avatar-title" && avatarDraft) avatarDraft.title = event.target.value;
  if (event.target.id === "avatar-script") {
    if (avatarDraft) avatarDraft.script = event.target.value;
    const counter = document.querySelector("#avatar-script-count");
    if (counter) counter.textContent = `${Array.from(event.target.value).length}/90`;
  }
});

document.addEventListener("change", (event) => {
  if (isGuardedFormTarget(event.target)) markUnsavedFormDirty(true);
  if (event.target.matches?.("[data-pagination-size]")) {
    const listKey = event.target.dataset.listKey;
    if (listKey) {
      const current = ui.listPagination[listKey] || {};
      ui.listPagination[listKey] = { ...current, page:1, pageSize:Number(event.target.value) || 10 };
      hydrateListPagination();
    }
    return;
  }
  if (event.target.id === "knowledge-intake-status") {
    ui.knowledgeIntakeStatus = event.target.value;
    persistKnowledgeIntakeFilterState();
    void hydrateKnowledgeIntake({ force:true });
    return;
  }
  if (event.target.id === "knowledge-intake-content-type") {
    ui.knowledgeIntakeContentType = event.target.value;
    persistKnowledgeIntakeFilterState();
    void hydrateKnowledgeIntake({ force:true });
    return;
  }
  if (event.target.id === "knowledge-intake-public-scope") {
    ui.knowledgeIntakePublicScope = event.target.value;
    persistKnowledgeIntakeFilterState();
    void hydrateKnowledgeIntake({ force:true });
    return;
  }
  if (handoverOnlyMode) {
    if (event.target.id === "role-select") toast("生产身份和权限由企业登录确定，页面不能切换", "warning");
    return;
  }
  if (event.target.id === "role-select") {
    toast("岗位由服务端实名授权决定，页面不能切换", "warning"); return;
    store.state.currentRole = normalizePhaseOneRole(event.target.value);
    const requestedRoute = location.hash.replace(/^#\/?/, "").split("/")[0] || "workbench";
    if (!canOpenRouteInCurrentRole(requestedRoute)) location.hash = "#/conversations";
    else render(true);
    toast(`已切换为${store.state.currentRole}视角`, "success");
  }
  if (event.target.id === "customer-owner") { ui.customerOwner = event.target.value; render(true); }
  if (event.target.id === "customer-stage") { ui.customerStage = event.target.value; render(true); }
  if (event.target.id === "knowledge-risk") { ui.knowledgeRisk = event.target.value; ui.knowledgePage = 1; render(true); }
  if (event.target.id === "knowledge-part") { ui.knowledgePart = event.target.value; ui.knowledgePage = 1; render(true); }
  if (event.target.id === "knowledge-page-size") { ui.knowledgePageSize = Number(event.target.value) || 10; ui.knowledgePage = 1; render(true); }
  if (event.target.id === "physician-status") { ui.physicianStatus = event.target.value; render(true); }
  if (event.target.id === "physician-specialty") { ui.physicianSpecialty = event.target.value; render(true); }
  const avatarDraft = routeAvatarPhysician() ? avatarDraftFor(routeAvatarPhysician()) : null;
  if (event.target.id === "avatar-voice-id" && avatarDraft) avatarDraft.voiceId = event.target.value;
  if (event.target.id === "avatar-resolution" && avatarDraft) avatarDraft.resolution = event.target.value;
  if (event.target.id === "avatar-duration" && avatarDraft) avatarDraft.duration = Number(event.target.value);
  if (event.target.id === "avatar-ratio" && avatarDraft) avatarDraft.ratio = event.target.value;
  if (event.target.id === "analytics-range") { ui.analyticsRange = event.target.value; toast(`分析时间范围已切换为${event.target.value}`, "success"); }
});

// C-030 AC3：长表单的未保存提醒与防重复提交。
const UNSAVED_GUARD_FORM_IDS = new Set(["knowledge-intake-form", "knowledge-maintenance-form", "configuration-record-form", "publication-form", "product-form", "journey-create-form", "agent-form"]);
let unsavedFormDirty = false;
const markUnsavedFormDirty = (value) => { unsavedFormDirty = Boolean(value); };
const isGuardedFormTarget = (target) => {
  const form = target?.closest?.("form");
  return Boolean(form && UNSAVED_GUARD_FORM_IDS.has(form.id));
};

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  // C-030 AC3：长表单未保存时离开/关闭要提醒，避免误关丢内容。
  if (UNSAVED_GUARD_FORM_IDS.has(form.id)) markUnsavedFormDirty(true);
  // C-030 AC3：同一表单提交进行中忽略重复提交，并禁用提交按钮，避免长表单被重复写入。
  if (form.dataset.submitting === "true") return;
  const submitter = form.querySelector('button[type="submit"]');
  form.dataset.submitting = "true";
  if (submitter) submitter.disabled = true;
  try {
  if(form.id==='publication-form'){
    try{
      const action=form.dataset.operation;const data=new FormData(form);let payload;
      if(action==='build')payload={document_ids:data.getAll('document_ids')};
      else if(action==='evaluate'){const file=data.get('report');if(!file?.size||file.size>1024*1024)throw new Error('请上传1MB以内的已签名评测 JSON');payload={report:JSON.parse(await file.text())};}
      else payload={reason:data.get('reason'),confirmed:data.get('confirmed')==='on',expected_revision:Number(form.dataset.revision)};
      await writeKnowledgePublication(form.dataset.packageId,action,payload,form.dataset.requestKey);
      closeModal();await refreshPublications();toast('发布操作已保存，状态以服务端记录为准','success');
    }catch(e){toast(e.message,'danger');}return;
  }
  if(form.id==='managed-account-form'){
    try{const data=Object.fromEntries(new FormData(form));const payload={...data,departments:data.departments.split(/[，,]/).map(s=>s.trim()).filter(Boolean),enabled:data.enabled==='启用'};
      if(!payload.password)delete payload.password;if(!payload.oidc_subject)delete payload.oidc_subject;
      if(form.dataset.subject){payload.subject=form.dataset.subject;payload.expected_version=Number(form.dataset.version);}
      const saved=await saveManagedAccount(payload);closeModal();await refreshManagedAccounts();toast(saved.handover_required?'权限已更新，请移交该人员尚未完结的服务事项':'账号权限已保存','success');
    }catch(e){toast(e.message,'danger');}return;
  }
  if (handoverOnlyMode && !["handover-complete-form", "appointment-resolve-form", "knowledge-intake-form", "knowledge-maintenance-form"].includes(form.id)) {
    toast("该表单尚未接入正式服务，生产模式未执行任何变更", "warning");
    return;
  }
  if (isPresalesWorkspace() && !presalesAllowedForms.has(form.id)) {
    toast("售前人员只能提交本人接管的会话处理结果或预约确认，不可维护平台运营数据", "warning");
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  if (form.id === "journey-node-form") {
    updateJourneyCanvasNode(form);
    return;
  }
  if (form.id === "journey-create-form") {
    const nodes = String(data.nodes || "").split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
    if (nodes.length < 2) return toast("旅程至少需要两个步骤", "warning");
    const journey = store.addJourney({
      name:data.name.trim(),
      stage:data.stage,
      owner:data.owner.trim(),
      nodes
    });
    closeModal();
    location.hash = `#/journey/${journey.id}`;
    toast("旅程草稿已创建并保存到本地服务", "success");
    return;
  }
  if (form.id === "agent-form") {
    const responsibilities = agentFieldList(data.responsibilities);
    const skills = agentFieldList(data.skills);
    const forbidden = agentFieldList(data.forbidden);
    const knowledgeScopeLabels = agentFieldList(data.knowledgeScopeLabels);
    const projectScopes = agentFieldList(data.projectScopes);
    const evaluationThreshold = Number(data.evaluationThreshold);
    const lastEvalRaw = String(data.lastEval || "").trim();
    const lastEval = lastEvalRaw === "" ? null : Number(lastEvalRaw);
    if (!data.name.trim() || !data.role.trim() || !data.owner.trim() || !data.version.trim() || !data.knowledge.trim()) {
      return toast("请补齐智能体名称、岗位职责、负责人、配置版本和默认知识范围", "warning");
    }
    if (!responsibilities.length || !skills.length || !forbidden.length || !knowledgeScopeLabels.length) {
      return toast("请至少填写一项岗位职责、允许能力、禁止动作和知识范围标签", "warning");
    }
    if (!Number.isFinite(evaluationThreshold) || evaluationThreshold <= 0 || evaluationThreshold > 100) {
      return toast("准入最低分必须是 1 至 100 之间的数值", "warning");
    }
    if (lastEval !== null && (!Number.isFinite(lastEval) || lastEval < 0 || lastEval > 100)) {
      return toast("最近评测得分必须是 0 至 100 之间的数值", "warning");
    }
    const payload = {
      name:data.name.trim(),
      role:data.role.trim(),
      owner:data.owner.trim(),
      ownerId:data.ownerId.trim(),
      version:data.version.trim(),
      status:data.status,
      levelCode:data.levelCode,
      knowledge:data.knowledge.trim(),
      responsibilities,
      skills,
      forbidden,
      knowledgeScopeLabels,
      projectScopes,
      evaluationThreshold,
      evaluationGate:{
        suite:data.evaluationSuite.trim(),
        evidenceRef:data.evidenceRef.trim()
      }
    };
    if (lastEval !== null) payload.lastEval = lastEval;
    const agentId = String(form.dataset.agentId || "");
    const saved = agentId ? store.updateAgent(agentId, payload) : store.addAgent(payload);
    if (!saved) return toast("智能体配置保存失败，请刷新后重试", "danger");
    closeModal();
    render(true);
    const requestedStatus = data.status;
    const message = saved.status !== requestedStatus
      ? `${saved.name} 已保存为草稿：请补齐准入信息并达到评测门槛后再申请${requestedStatus}`
      : `${saved.name} 已${agentId ? "更新" : "创建"}，当前状态为${saved.status}`;
    toast(message, "success");
    return;
  }
  if (form.id === "management-user-form") {
    const role = (store.state.managementRoles || []).find((item) => item.id === data.roleId);
    if (!role) return toast("请选择已创建的角色", "warning");
    const payload = {
      name:data.name.trim(),
      nickname:data.nickname.trim(),
      account:data.account.trim(),
      staffId:data.staffId.trim(),
      department:data.department.trim(),
      roleId:role.id,
      role:role.name,
      status:data.status
    };
    const user = form.dataset.userId
      ? store.updateManagementUser(form.dataset.userId, payload)
      : store.addManagementUser(payload);
    if (!user) return toast("用户保存失败，请刷新后重试", "danger");
    closeModal(); render(true); toast(`用户 ${user.name} 已${form.dataset.userId ? "更新" : "创建"}`, "success");
    return;
  }
  if (form.id === "management-role-form") {
    closeModal();
    toast("一期角色固定为管理员和售前人员，暂不支持角色维护", "warning");
    return;
  }
  if (form.id === "configuration-record-form") {
    const kind = String(form.dataset.kind || "");
    const recordId = String(form.dataset.recordId || "");
    let payload;
    if (kind === "message_template") {
      const content = data.content.trim();
      const { unknown } = extractTemplateVariables(content);
      if (unknown.length) return toast(`模板变量未定义：${unknown.map((name) => `{{${name}}}`).join("、")}；请改用已命名变量`, "warning");
      payload = {
        kind,
        name:data.name.trim(),
        category:normalizeTemplateCategory(data.category),
        scope:data.scope.trim(),
        executionMode:data.executionMode,
        status:data.status,
        content
      };
      if (!recordId) payload.version = 1;
      if (!payload.name || !payload.scope || !payload.content) return toast("请补齐模板名称、适用环节和模板内容", "warning");
    } else if (kind === "journey_template") {
      const nodes = String(data.nodes || "").split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
      if (!data.name.trim() || nodes.length < 2) return toast("请填写模板名称，并至少配置两个流程步骤", "warning");
      payload = {
        kind,
        name:data.name.trim(),
        stage:data.stage,
        owner:data.owner.trim(),
        status:data.status,
        nodes,
        description:data.description.trim()
      };
    } else if (kind === "segment") {
      const minScoreText = String(data.minScore || "").trim();
      const minScore = minScoreText === "" ? null : Number(minScoreText);
      if (minScore !== null && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) return toast("最低兴趣分必须是 0 至 100 之间的数值", "warning");
      const criteria = {
        macroStage:data.macroStage || "",
        microStage:data.microStage.trim(),
        project:data.project.trim(),
        ...(minScore === null ? {} : { minScore })
      };
      if (!criteria.macroStage && !criteria.microStage && !criteria.project && minScore === null) return toast("请至少设置一个分群条件", "warning");
      payload = {
        kind,
        name:data.name.trim(),
        owner:data.owner.trim(),
        status:data.status,
        journeyId:data.journeyId || "",
        criteria,
        rule:data.rule.trim()
      };
      if (!payload.name || !payload.rule) return toast("请补齐分群名称和规则说明", "warning");
    } else {
      return toast("运营配置类型无效", "warning");
    }
    const record = recordId
      ? store.updateConfigurationRecord(recordId, payload)
      : store.addConfigurationRecord(payload);
    if (!record) return toast("运营配置保存失败，请刷新后重试", "danger");
    closeModal(); render(true); toast(`${record.name} 已${recordId ? "更新" : "保存"}到本地服务`, "success");
    return;
  }
  if (form.id === "product-form") {
    const payload = {
      name:data.name.trim(), productCode:data.productCode.trim(), department:data.department.trim(), category:data.category.trim(),
      serviceType:data.serviceType, salesStatus:data.salesStatus, approvalStatus:data.approvalStatus, owner:data.owner.trim(),
      branch:data.branch.trim(), channel:data.channel.trim(), priceType:data.priceType, price:data.price.trim(),
      originalPrice:data.originalPrice.trim(), priceApplicableScope:data.priceApplicableScope.trim(),
      priceApprovalStatus:data.priceApprovalStatus, priceEffectiveAt:data.priceEffectiveAt, priceExpiresAt:data.priceExpiresAt,
      highlights:data.highlights.trim(), description:data.description.trim()
    };
    if (payload.priceExpiresAt && payload.priceEffectiveAt && payload.priceExpiresAt <= payload.priceEffectiveAt) return toast("价格失效日期必须晚于生效日期", "warning");
    const productId = form.dataset.productId;
    const product = productId ? store.updateProduct(productId, payload) : store.addProduct(payload);
    if (!product) return toast("产品保存失败，请刷新后重试", "warning");
    closeModal(); location.hash = "#/catalog"; toast(`产品 ${product.name} 已保存`, "success");
    return;
  }
  if (form.id === "knowledge-maintenance-form") {
    const action = form.dataset.operation;
    clearKnowledgeFieldErrors(form);
    const payload = { ...data, expected_version:Number(form.dataset.version) };
    if (action === "edit") {
      payload.applicable_campuses = String(data.applicable_campuses || "").split(/[、,，]/).map((part) => part.trim()).filter(Boolean);
      payload.customer_facing_candidate = data.public_scope !== "internal";
    }
    for (const key of ["effective_at", "expires_at", "confirmed_at", "confirmation_expires_at"]) {
      if (payload[key]) payload[key] = new Date(payload[key]).toISOString();
    }
    const submit = document.querySelector(`[form="${form.id}"][type="submit"]`);
    if (submit) submit.disabled = true;
    try {
      await mutateManagementKnowledgeIntakeDocument(form.dataset.documentId, action, payload);
      closeModal();
      await hydrateKnowledgeIntake({ force:true });
      toast(action === "edit" ? "已保存新版本，请重新登记院方确认" : action === "confirmation" ? "确认凭据已登记，尚未对客发布" : "候选已准备，等待正式评测与发布", "success");
    } catch (error) {
      if (error.code === "KNOWLEDGE_VERSION_CONFLICT") {
        try {
          const latest = await getManagementKnowledgeIntakeDocument(form.dataset.documentId);
          showKnowledgeVersionConflictModal({ document:latest, action, payload });
          toast("资料已被其他操作更新，请比较后选择下一步", "warning");
          return;
        } catch {
          toast("资料版本已变化，但无法读取最新版本；本次修改未保存", "danger");
          return;
        }
      }
      const fieldErrorShown = showKnowledgeFieldErrors(form, error);
      toast(fieldErrorShown ? "请修正标红字段后重试" : error.status === 409 ? "版本或请求状态已变化，请关闭后重新打开资料" : error.message || "资料维护失败", "danger");
      if (submit) submit.disabled = false;
    }
    return;
  }
  if (form.id === "knowledge-intake-form") {
    clearKnowledgeFieldErrors(form);
    const file = form.querySelector('input[name="source_file"]')?.files?.[0];
    if (!file) return toast("请先选择需要录入的资料文件", "warning");
    const extension = String(file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    const maxBytes = ["txt", "md", "markdown", "csv", "json"].includes(extension)
      ? 256 * 1024
      : ["jpg", "jpeg", "png", "webp"].includes(extension)
        ? 16 * 1024 * 1024
        : 32 * 1024 * 1024;
    const maxLabel = maxBytes === 256 * 1024 ? "256KB" : maxBytes === 16 * 1024 * 1024 ? "16MB" : "32MB";
    if (file.size < 1 || file.size > maxBytes) return toast(`该格式单次原始素材需在1字节至${maxLabel}之间；服务端会再次校验。`, "warning");
    const submit = form.querySelector('button[type="submit"]') || document.querySelector(`[form="${form.id}"][type="submit"]`);
    if (submit) { submit.disabled = true; submit.textContent = "正在上传并解析…"; }
    try {
      const created = await uploadManagementKnowledgeIntakeAsset({
        file,
        department:data.department,
        content_type:data.content_type,
        owner:data.owner,
        tags:String(data.tags || "").split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean),
        customer_facing_candidate:data.customer_facing_candidate === "on",
        public_scope:data.customer_facing_candidate === "on" ? "customer_summary" : "internal"
      });
      ui.knowledgeIntakeDocuments = [created.document, ...(ui.knowledgeIntakeDocuments || []).filter((item) => item.id !== created.document.id)];
      closeModal();
      const parsePending = created.document.parser_status === "pending_controlled_parse";
      const parseNeedsAttention = created.document.parser_status === "needs_attention";
      toast(created.duplicate ? "发现相同资料，已保留既有内部记录" : created.replayed ? "素材已入库，无需重复处理" : parseNeedsAttention ? "检测到解析质量问题，已标为待处理且未建立检索块" : parsePending ? "原始素材已隔离保存，正在等待受控解析" : "原始素材已完成受控解析并保存为内部草稿", parseNeedsAttention ? "warning" : "success");
      await hydrateKnowledgeIntake({ force:true });
    } catch (error) {
      const fieldErrorShown = showKnowledgeFieldErrors(form, error);
      toast(fieldErrorShown ? "请修正标红字段后重试" : error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN" ? "当前账号无权维护该科室资料" : error.message || "资料解析或保存失败", "danger");
      if (submit) { submit.disabled = false; submit.textContent = "上传并受控解析"; }
    }
    return;
  }
  if (form.id === "appointment-resolve-form") {
    const intake = (ui.appointmentIntakes || []).find((item) => item.id === form.dataset.appointmentIntakeId);
    if (!intake) return toast("预约事项已不存在，请刷新队列", "warning");
    if (!String(data.note || "").trim()) return toast("请填写跟进说明", "warning");
    const submit = form.querySelector('button[type="submit"]') || document.querySelector(`[form="${form.id}"][type="submit"]`);
    if (submit) { submit.disabled = true; submit.textContent = "正在提交…"; }
    try {
      const resolved = await resolveManagementAppointmentIntake(intake.id, {
        status:data.status,
        note:data.note
      });
      const index = ui.appointmentIntakes.findIndex((item) => item.id === resolved.intake.id);
      if (index >= 0) ui.appointmentIntakes[index] = resolved.intake;
      closeModal();
      toast(`跟进结果已保存：${appointmentStatusLabel(resolved.intake.followup_status)}`, "success");
      await syncAppointmentOperations();
    } catch (error) {
      toast(error.status === 409 ? "登记或跟进状态已变更，请刷新后重试" : "预约处理失败，请稍后重试", "danger");
      if (submit) { submit.disabled = false; submit.textContent = "提交处理结果"; }
    }
    return;
  }
  if (form.id === "handover-complete-form") {
    const handover = store.handover(form.dataset.handoverId);
    const minutes = Number(data.minutes);
    if (!handover) return toast("接管任务已不存在，请刷新队列", "warning");
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) return toast("实际付出时间必须是 0–1440 之间的分钟数", "warning");
    const submit = form.querySelector('button[type="submit"]') || document.querySelector(`[form="${form.id}"][type="submit"]`);
    if (submit) { submit.disabled = true; submit.textContent = "正在完结…"; }
    try {
      const completion = await completeManagementHandoverWithWork(handover.id, {
        resolution:data.resolution,
        minutes,
        notes:data.notes
      });
      store.updateAcquisitionHandover(completion.handover);
      closeModal();
      const resumeRobot = form.dataset.resumeRobot === "true";
      toast(completion.replayed
        ? "该接管已完结，原工时记录保持不变"
        : resumeRobot
          ? "人工处理与实际付出时间已记录，机器人将按规则处理后续新消息"
          : "接管与实际付出时间已一并记录", "success");
      await syncAcquisitionHandovers(true);
    } catch (error) {
      const message = error.status === 401
        ? "请先完成企业实名登录"
        : error.status === 403
          ? "只有当前实名接管顾问可以完结任务"
          : error.status === 409
            ? "任务状态已变更，请刷新后重试"
            : "完结失败，请稍后重试";
      toast(message, "danger");
      if (submit) { submit.disabled = false; submit.textContent = "确认完结并登记"; }
    }
    return;
  }
  if (form.id === "physician-avatar-form") { submitPhysicianAvatar(form); return; }
  if (form.id === "conversation-create-form") {
    const conversation = store.createConversationDraft({ customerId:data.customerId, channel:data.channel });
    if (!conversation) return toast("关联客户不存在，未创建会话", "danger");
    ui.conversationFilter = "全部";
    ui.conversationId = conversation.id;
    closeModal();
    if (location.hash === "#/conversations") render(true);
    else location.hash = "#/conversations";
    toast("会话草稿已创建，尚未向客户发送消息", "success");
    return;
  }
  if (form.id === "knowledge-create-form") {
    const item = store.addKnowledgeDraft({
      title:data.title.trim(),
      project:data.project.trim(),
      risk:data.risk,
      riskCode:data.risk,
      riskLabel:data.risk === "H3" ? "高风险审核" : data.risk === "H2" ? "重点审核" : "常规审核",
      owner:data.owner.trim(),
      excerpt:data.excerpt.trim(),
      sourceTitle:data.sourceReference.trim(),
      sections:[{ title:"草稿内容", content:data.excerpt.trim() }]
    });
    ui.knowledgeTab = "知识库";
    ui.knowledgePage = 1;
    closeModal();
    render(true);
    toast(`知识条目 ${item.id} 已保存`, "success");
    return;
  }
  if (form.id === "connector-create-form") {
    const connector = store.addConnector({
      name:data.name.trim(),
      vendor:data.vendor.trim(),
      direction:data.direction,
      purpose:data.purpose.trim()
    });
    closeModal();
    location.hash = `#/connector/${connector.id}`;
    toast("连接器配置已保存，待在部署环境配置凭据和回调校验", "success");
    return;
  }
  if (form.id === "task-form") {
    store.addTask({ ...data, dueAt: new Date(data.dueAt).toISOString(), source: "人工创建" }); closeModal(); toast("任务已创建并进入今日工作台", "success");
  }
  if (form.id === "profile-form") {
    const customer = store.customer(form.dataset.customerId);
    store.updateCustomer(customer.id, { profile: { ...customer.profile, budget:data.budget, decision:data.decision, contact:data.contact, style:data.style, concern:data.concern, confidence:100 }, tags:data.tags.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) }, { type:"profile", title:"客户画像由人工更新", detail:`${data.evidence}；系统已重新生成下一步建议。`, actor:"当前用户", channel:"系统", tone:"positive" }); closeModal(); toast("画像已更新，下一步建议已重新生成", "success");
  }
  if (form.id === "stage-form") {
    store.updateCustomer(form.dataset.customerId, { macroStage:data.macroStage, microStage:data.microStage, stageEnteredAt:new Date().toISOString(), sla:"正常" }, { type:"stage", title:`阶段更新：${data.macroStage} / ${data.microStage}`, detail:`依据：${data.evidence}；阻塞原因：${data.blockReason}`, actor:"当前用户", channel:"系统", tone:"positive" }); closeModal(); toast("生命周期已更新并写入时间线", "success");
  }
  if (form.id === "photo-form") {
    store.updateCustomer(form.dataset.customerId, { photoConsent:data.photoConsent, photoUpdatedAt:new Date().toISOString() }, { type:"consent", title:`照片授权更新：${data.photoConsent}`, detail:data.evidence, actor:"当前用户", channel:"系统", tone:data.photoConsent === "已授权" ? "positive" : "risk" }); closeModal(); toast("照片授权状态已更新", "success");
  }
  if (form.id === "reassign-form") {
    store.updateCustomer(form.dataset.customerId, { owner:data.owner, agent:data.agent }, { type:"assignment", title:"客户责任链变更", detail:`人工主责：${data.owner}；主责AI：${data.agent}；原因：${data.evidence}`, actor:"当前用户", channel:"系统", tone:"neutral" }); closeModal(); toast("责任链已更新", "success");
  }
  if (form.id === "nba-form") {
    const customer = store.customer(form.dataset.customerId); store.updateCustomer(customer.id, { nextAction:{...customer.nextAction,title:data.title,owner:data.owner,channel:data.channel,reason:data.reason,status:"待执行"} }, { type:"strategy", title:"下一步建议已调整", detail:data.reason, actor:"当前用户", channel:"系统", tone:"neutral" }); closeModal(); toast("新建议已生效", "success");
  }
  if (form.id === "join-journey-form") {
    const customer = store.customer(form.dataset.customerId); const journey = store.state.journeys.find((item) => item.id === data.journeyId); if (!customer.journeys.some((item) => item.id === journey.id)) customer.journeys.push({ id:journey.id,name:journey.name,node:journey.nodes[0],status:"运行中" }); customer.timeline.unshift({id:`E-${Date.now()}`,type:"journey",title:`加入旅程：${journey.name}`,detail:`${data.entry}；授权、频控和互斥检查通过。`,occurredAt:new Date().toISOString(),actor:"当前用户",channel:"系统",tone:"ai"}); store.save(); closeModal(); toast("客户已加入旅程", "success");
  }
  if (form.id === "customer-form") {
    const now = new Date().toISOString();
    const customer = sanitizeDisplayData({
      id:`C-${Date.now()}`,
      name:data.name.trim(),
      mobile:data.mobile.trim(),
      source:data.source,
      firstChannel:data.source,
      latestChannel:data.source,
      owner:data.owner.trim(),
      agent:"",
      macroStage:"售前",
      microStage:"首次咨询",
      stageEnteredAt:now,
      sla:"待配置",
      score:0,
      health:0,
      photo:"",
      photoConsent:"未上传",
      photoUpdatedAt:null,
      tags:[],
      interests:[],
      pains:[],
      itches:[],
      delights:[],
      profile:{ budget:"", decision:"", contact:"", style:"", concern:"", confidence:0 },
      nextAction:{ title:"待人工制定", reason:"客户档案刚创建，尚无可核验的沟通依据", owner:data.owner.trim(), channel:data.source, dueAt:"", status:"待配置", guardrail:"仅在取得相应授权后联系客户" },
      journeys:[],
      timeline:[{ id:`E-${Date.now()}`, type:"lead", title:"人工创建客户档案", detail:`来源：${data.source}`, occurredAt:now, actor:"当前用户", channel:"系统", tone:"neutral" }]
    });
    store.state.customers.unshift(customer);
    store.save();
    closeModal();
    toast("客户档案已创建并保存到本地服务", "success");
  }
  if (form.id === "physician-form") {
    const list = (value) => String(value || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
    const payload = {
      name: data.name.trim(), gender: data.gender, title: data.title, department: data.department,
      branch: data.branch.trim(), status: data.status, years: Math.max(0, Number(data.years) || 0),
      education: data.education.trim(), hospitalTenure: data.hospitalTenure.trim(), mobile: data.mobile.trim(),
      registrationNo: data.registrationNo.trim(), registrationScope: data.registrationScope.trim(), schedule: data.schedule.trim(),
      specialties: list(data.specialties), signatureProjects: list(data.signatureProjects), bio: data.bio.trim()
    };
    if (form.dataset.physicianId) {
      store.updatePhysician(form.dataset.physicianId, payload);
      closeModal();
      toast("医师资料已更新，领域分布同步完成", "success");
    } else {
      store.addPhysician(payload);
      closeModal();
      toast("医师档案已创建并加入团队", "success");
    }
  }
  } finally {
    form.dataset.submitting = "false";
    if (submitter?.isConnected) submitter.disabled = false;
    // 提交成功会关闭弹窗；弹窗已关闭即视为已保存，仍打开则保留未保存提醒。
    if (UNSAVED_GUARD_FORM_IDS.has(form.id) && !document.querySelector(".modal-backdrop")) markUnsavedFormDirty(false);
  }
});

window.addEventListener("hashchange", () => {
  clearRevealedContact({ markHidden:false });
  closeModal();
  if (!handoverOnlyMode) syncAvatarStudioScope();
  render();
  const route = routeInfo();
  if (route.route === "conversations" && route.id === "bad-cases") void syncBadCases();
});

const MANAGEMENT_SERVER_ONLY_SOURCES = new Set([
  "management-hydrate",
  "acquisition-sync",
  "acquisition-operations-sync"
]);
let managementPersistTimer = null;
let managementPersistInFlight = false;
let managementPersistQueued = false;

const managementOverlaySignature = () => JSON.stringify(store.managementOverlay());

const hydrateManagementDomain = async ({ announce = false } = {}) => {
  if (handoverOnlyMode) return null;
  ui.managementDataLoading = true;
  ui.managementDataError = "";
  ui.managementPersistenceState = "loading";
  render(true);
  try {
    const record = await getManagementDomainOverlay();
    if (!record) throw new Error("管理数据服务未返回有效记录");
    store.hydrateManagementOverlay(record);
    ui.managementDataReady = true;
    ui.managementDataError = "";
    ui.managementPersistenceState = "saved";
    if (announce) toast("管理后台已重新连接到本地持久化服务", "success");
    return record;
  } catch (error) {
    ui.managementDataReady = false;
    ui.managementDataError = error.status === 401
      ? "请先完成管理后台登录"
      : error.message || "管理数据服务不可用";
    ui.managementPersistenceState = "error";
    return null;
  } finally {
    ui.managementDataLoading = false;
    render(true);
  }
};

const flushManagementOverlay = async () => {
  managementPersistTimer = null;
  if (managementPersistInFlight || handoverOnlyMode || !ui.managementDataReady) return;
  managementPersistInFlight = true;
  managementPersistQueued = false;
  const revision = store.serverRevision;
  const overlay = store.managementOverlay();
  const sentSignature = JSON.stringify(overlay);
  ui.managementPersistenceState = "saving";
  ui.managementPersistenceError = "";
  try {
    const saved = await saveManagementDomainOverlay({ revision, overlay });
    store.serverRevision = Number(saved.record?.revision) || revision;
    ui.managementPersistenceState = "saved";
  } catch (error) {
    ui.managementPersistenceState = "error";
    ui.managementPersistenceError = error.code || error.message || "MANAGEMENT_SAVE_FAILED";
    if (error.code === "MANAGEMENT_REVISION_CONFLICT") {
      toast("后台数据已被其他操作更新，请重新连接后再继续修改", "warning");
    } else {
      toast("本次修改尚未保存到本地服务，请检查服务后重试", "danger");
    }
  } finally {
    managementPersistInFlight = false;
    // Preserve rapid, consecutive operator edits: a second commit is queued
    // only when the state changed after the in-flight snapshot was captured.
    if (ui.managementDataReady && (managementPersistQueued || sentSignature !== managementOverlaySignature())) {
      managementPersistQueued = false;
      if (!managementPersistTimer) managementPersistTimer = window.setTimeout(flushManagementOverlay, 120);
    }
  }
};

const scheduleManagementOverlayPersist = () => {
  if (handoverOnlyMode || !ui.managementDataReady) return;
  managementPersistQueued = true;
  if (managementPersistInFlight || managementPersistTimer) return;
  managementPersistTimer = window.setTimeout(flushManagementOverlay, 220);
};

store.addEventListener("change", (event) => {
  if (["acquisition-sync","acquisition-operations-sync"].includes(event.detail?.source)) {
    if(document.querySelector('.reception-page .conversation-layout')){updateReceptionWindow();return;}
    if(!['conversations','customers','customer'].includes(routeInfo().route))return;
  }
  render(true);
  if (!MANAGEMENT_SERVER_ONLY_SOURCES.has(event.detail?.source)) scheduleManagementOverlayPersist();
});
let acquisitionSyncPromise = null;
let acquisitionChannelsSyncPromise = null;
let handoverSyncPromise = null;
let appointmentSyncPromise = null;
let badCaseSyncPromise = null;
let knowledgeGovernanceSyncPromise = null;
let knowledgeIntakeSyncPromise = null;
let lastHandoverSyncSucceeded = true;
let handoverPollTimer = null;
let handoverPollFailures = 0;
let handoverPollingDestroyed = false;
const HANDOVER_POLL_BASE_MS = 15_000;
const HANDOVER_POLL_MAX_BACKOFF_MS = 60_000;
const syncAcquisitionCustomers = async () => {
  if (acquisitionSyncPromise) return acquisitionSyncPromise;
  acquisitionSyncPromise = fetch("/api/local/acquisition-customers", { headers:{ Accept:"application/json" } })
    .then(async (response) => {
      if (!response.ok) throw new Error("获客客户同步失败");
      const body = await response.json();
      ui.conversationSyncError="";
      store.upsertAcquisitionSnapshot(body.data);
    })
    .catch(() => {ui.conversationSyncError="会话同步失败，请刷新重试";if(routeInfo().route==="conversations")render(true);})
    .finally(() => { acquisitionSyncPromise = null; });
  return acquisitionSyncPromise;
};
const syncAcquisitionChannels = async () => {
  if (acquisitionChannelsSyncPromise) return acquisitionChannelsSyncPromise;
  ui.acquisitionChannelsLoading = true;
  acquisitionChannelsSyncPromise = listManagementAcquisitionChannels()
    .then((channels) => {
      ui.acquisitionChannelStatuses = channels;
      ui.acquisitionChannelsError = "";
      return channels;
    })
    .catch((error) => {
      ui.acquisitionChannelsError = error.code || "ACQUISITION_CHANNELS_SYNC_FAILED";
      return [];
    })
    .finally(() => {
      ui.acquisitionChannelsLoading = false;
      acquisitionChannelsSyncPromise = null;
      if (routeInfo().route === "conversations") render(true);
    });
  return acquisitionChannelsSyncPromise;
};
const hydrateKnowledgeGovernance = async ({ force = false, announce = false } = {}) => {
  if (knowledgeGovernanceSyncPromise) return knowledgeGovernanceSyncPromise;
  if (ui.knowledgeGovernance && !force) return ui.knowledgeGovernance;
  const token = ++ui.knowledgeGovernanceRequestToken;
  ui.knowledgeGovernanceLoading = true;
  ui.knowledgeGovernanceError = "";
  if (routeInfo().route === "knowledge" && ui.knowledgeTab === "准入与发布") render(true);
  knowledgeGovernanceSyncPromise = getManagementKnowledgeGovernance()
    .then((overview) => {
      if (token === ui.knowledgeGovernanceRequestToken) {
        ui.knowledgeGovernance = overview;
        ui.knowledgeGovernanceError = "";
        if (announce) toast("知识准入、对客版本和图谱状态已刷新", "success");
      }
      return overview;
    })
    .catch((error) => {
      if (token === ui.knowledgeGovernanceRequestToken) {
        ui.knowledgeGovernanceError = error.code || "KNOWLEDGE_GOVERNANCE_SYNC_FAILED";
        if (announce) toast(error.status === 401 ? "请先完成企业实名登录" : "知识治理状态暂时无法读取", error.status === 401 ? "warning" : "danger");
      }
      return null;
    })
    .finally(() => {
      if (token === ui.knowledgeGovernanceRequestToken) ui.knowledgeGovernanceLoading = false;
      knowledgeGovernanceSyncPromise = null;
      if (routeInfo().route === "knowledge" && ui.knowledgeTab === "准入与发布") render(true);
    });
  return knowledgeGovernanceSyncPromise;
};

const hydrateKnowledgeIntake = async ({ force = false, announce = false } = {}) => {
  if (!knowledgeIntakeEnabled) return [];
  if (knowledgeIntakeSyncPromise && !force) return knowledgeIntakeSyncPromise;
  if (ui.knowledgeIntakeDocuments.length && !force) return ui.knowledgeIntakeDocuments;
  const requestToken = ++ui.knowledgeIntakeRequestToken;
  ui.knowledgeIntakeLoading = true;
  ui.knowledgeIntakeError = "";
  if (routeInfo().route === "knowledge") render(true);
  const request = listManagementKnowledgeIntakeDocuments({
    query:ui.knowledgeIntakeQuery,
    status:ui.knowledgeIntakeStatus,
    contentType:ui.knowledgeIntakeContentType,
    publicScope:ui.knowledgeIntakePublicScope,
    limit:200
  })
    .then((documents) => {
      if (requestToken !== ui.knowledgeIntakeRequestToken) return documents;
      ui.knowledgeIntakeDocuments = documents;
      ui.knowledgeIntakeError = "";
      if (announce) toast("内部资料录入列表已同步", "success");
      return documents;
    })
    .catch((error) => {
      if (requestToken !== ui.knowledgeIntakeRequestToken) return [];
      ui.knowledgeIntakeError = error.code || "KNOWLEDGE_INTAKE_SYNC_FAILED";
      if (announce) toast(error.status === 401 ? "请先完成企业实名登录" : "内部资料列表暂时无法读取", error.status === 401 ? "warning" : "danger");
      return [];
    })
    .finally(() => {
      if (requestToken !== ui.knowledgeIntakeRequestToken) return;
      ui.knowledgeIntakeLoading = false;
      knowledgeIntakeSyncPromise = null;
      if (routeInfo().route === "knowledge") render(true);
    });
  knowledgeIntakeSyncPromise = request;
  return request;
};
const syncAcquisitionHandovers = async (announce = false, { background = false } = {}) => {
  if (handoverSyncPromise) return handoverSyncPromise;
  if (!background) {
    ui.operationsLoading = true;
    if (["workbench", "conversations"].includes(routeInfo().route)) render(true);
  }
  handoverSyncPromise = listManagementHandovers({ limit:200 })
    .then((handovers) => {
      const previousOpenIds = new Set((store.state.handovers || [])
        .filter((item) => ["pending", "claimed", "active"].includes(item.status))
        .map((item) => item.id));
      const newUrgent = handovers.filter((item) => item.priority === "urgent"
        && ["pending", "claimed", "active"].includes(item.status)
        && !previousOpenIds.has(item.id));
      ui.operationsError = "";
      lastHandoverSyncSucceeded = true;
      store.replaceAcquisitionHandovers(handovers);
      if (newUrgent.length) toast(`${newUrgent.length} 条紧急会话已进入人工接管队列`, "danger");
      if (announce) toast("人工接管队列已同步", "success");
      return handovers;
    })
    .catch((error) => {
      ui.operationsError = error.code || "OPERATIONS_SYNC_FAILED";
      lastHandoverSyncSucceeded = false;
      if (announce) toast(error.status === 401 ? "请先完成企业实名登录" : "人工接管队列暂时无法读取", error.status === 401 ? "warning" : "danger");
      return [];
    })
    .finally(() => {
      if (!background) ui.operationsLoading = false;
      handoverSyncPromise = null;
      if (!background && ["workbench", "conversations"].includes(routeInfo().route)) render(true);
    });
  return handoverSyncPromise;
};

const syncAppointmentOperations = async (announce = false, { background = false } = {}) => {
  if (appointmentSyncPromise) return appointmentSyncPromise;
  if (!background) {
    ui.appointmentsLoading = true;
    if (routeInfo().route === "workbench") render(true);
  }
  appointmentSyncPromise = listManagementAppointmentIntakes({ limit:200 }).then((intakes) => {
    ui.appointmentIntakes = intakes;
    ui.appointmentsError = "";
    if (announce) toast("到院登记跟进队列已同步", "success");
    return intakes;
  }).catch((error) => {
    ui.appointmentsError = error.code || "APPOINTMENT_SYNC_FAILED";
    if (announce) toast(error.status === 401 ? "请先完成企业实名登录" : "预约队列暂时无法读取", error.status === 401 ? "warning" : "danger");
    return [];
  }).finally(() => {
    if (!background) ui.appointmentsLoading = false;
    appointmentSyncPromise = null;
    if (!background && routeInfo().route === "workbench") render(true);
  });
  return appointmentSyncPromise;
};

const syncBadCases = async (announce = false) => {
  if (badCaseSyncPromise) return badCaseSyncPromise;
  ui.badCasesLoading = true;
  ui.badCasesError = "";
  if (routeInfo().route === "conversations" && routeInfo().id === "bad-cases") render(true);
  badCaseSyncPromise = listManagementBadCases({ limit:200 })
    .then((badCases) => {
      ui.badCases = badCases;
      ui.badCasesError = "";
      ui.badCasesHydrated = true;
      if (announce) toast("Bad Case队列已同步", "success");
      return badCases;
    })
    .catch((error) => {
      ui.badCasesError = error.code || "BAD_CASE_SYNC_FAILED";
      ui.badCasesHydrated = true;
      if (announce) toast(error.status === 401 ? "请先完成企业实名登录" : "Bad Case队列暂时无法读取", error.status === 401 ? "warning" : "danger");
      return [];
    })
    .finally(() => {
      ui.badCasesLoading = false;
      badCaseSyncPromise = null;
      if (routeInfo().route === "conversations" && routeInfo().id === "bad-cases") render(true);
    });
  return badCaseSyncPromise;
};

const pauseHandoverPolling = () => {
  if (handoverPollTimer) clearTimeout(handoverPollTimer);
  handoverPollTimer = null;
};

const scheduleHandoverPoll = (delayMs = HANDOVER_POLL_BASE_MS) => {
  pauseHandoverPolling();
  if (!hasCapability("conversations:read_assigned") || handoverPollingDestroyed || document.visibilityState !== "visible") return;
  const boundedDelay = Math.min(
    HANDOVER_POLL_MAX_BACKOFF_MS,
    Math.max(HANDOVER_POLL_BASE_MS, Number(delayMs) || HANDOVER_POLL_BASE_MS)
  );
  handoverPollTimer = window.setTimeout(async () => {
    handoverPollTimer = null;
    if (!hasCapability("conversations:read_assigned") || handoverPollingDestroyed || document.visibilityState !== "visible") return;
    await Promise.all([
      syncAcquisitionHandovers(false, { background:true }),
      syncAppointmentOperations(false, { background:true }),
      ...(!handoverOnlyMode ? [syncAcquisitionCustomers()] : [])
    ]);
    handoverPollFailures = lastHandoverSyncSucceeded ? 0 : Math.min(handoverPollFailures + 1, 3);
    const nextDelay = lastHandoverSyncSucceeded
      ? HANDOVER_POLL_BASE_MS
      : Math.min(HANDOVER_POLL_MAX_BACKOFF_MS, HANDOVER_POLL_BASE_MS * (2 ** handoverPollFailures));
    scheduleHandoverPoll(nextDelay);
  }, boundedDelay);
};

const resumeHandoverPolling = async ({ immediate = false } = {}) => {
  if (!hasCapability("conversations:read_assigned") || handoverPollingDestroyed || document.visibilityState !== "visible") return;
  pauseHandoverPolling();
  if (immediate) {
    await Promise.all([
      syncAcquisitionHandovers(false, { background:true }),
      syncAppointmentOperations(false, { background:true }),
      ...(!handoverOnlyMode ? [syncAcquisitionCustomers()] : [])
    ]);
    handoverPollFailures = lastHandoverSyncSucceeded ? 0 : Math.min(handoverPollFailures + 1, 3);
  }
  scheduleHandoverPoll(lastHandoverSyncSucceeded
    ? HANDOVER_POLL_BASE_MS
    : Math.min(HANDOVER_POLL_MAX_BACKOFF_MS, HANDOVER_POLL_BASE_MS * (2 ** handoverPollFailures)));
};
window.addEventListener("focus", () => {
  if (!hasCapability("conversations:read_assigned")) return;
  if (!handoverOnlyMode) {
    syncAcquisitionCustomers();
    syncAcquisitionChannels();
  }
  resumeHandoverPolling({ immediate:true });
  if (!handoverOnlyMode && routeAvatarPhysician()) hydrateAvatarStudio(true, { background:true });
});
document.addEventListener("visibilitychange", () => {
  if (!hasCapability("conversations:read_assigned")) return;
  if (document.visibilityState === "visible") {
    if (!handoverOnlyMode) {
      syncAcquisitionCustomers();
      syncAcquisitionChannels();
    }
    resumeHandoverPolling({ immediate:true });
    if (!handoverOnlyMode && routeAvatarPhysician()) hydrateAvatarStudio(true, { background:true });
  } else {
    pauseHandoverPolling();
    if (!handoverOnlyMode) scheduleAvatarUiPoll();
  }
});
window.addEventListener("pagehide", () => {
  clearRevealedContact({ markHidden:false });
  pauseHandoverPolling();
});
window.addEventListener("pageshow", () => resumeHandoverPolling({ immediate:true }));
window.addEventListener("beforeunload", (event) => {
  clearRevealedContact({ markHidden:false });
  handoverPollingDestroyed = true;
  pauseHandoverPolling();
  // C-030 AC3：存在未保存的长表单内容时，浏览器需要二次确认后再离开。
  if (unsavedFormDirty) event.preventDefault();
});
const bootstrapManagementApplication = async () => {
  render();
  try{ui.managementIdentity=await getManagementIdentity();ui.identityError='';store.state.currentRole=ui.managementIdentity.role;setIdentityCapabilities(ui.managementIdentity.capabilities);}
  catch(e){ui.identityError=e.message;render();return;}
  ui.managementDataReady=true;
  if(hasCapability('users:manage'))await refreshManagedAccounts();
  if(hasCapability('knowledge:read'))await hydrateKnowledgeIntake();
  if(hasCapability('knowledge:read')||hasCapability('evaluations:read'))await refreshPublications();
  if(isPresalesWorkspace()||hasCapability('superadmin:manage')){
    if(!handoverOnlyMode)await hydrateManagementDomain();
    await Promise.all([syncAcquisitionHandovers(),syncAppointmentOperations(),...(hasCapability('superadmin:manage')?[syncAcquisitionCustomers()]:[])]);scheduleHandoverPoll();
  }
  render();
  connectConversationEvents();
};

void bootstrapManagementApplication();

let conversationEvents=null;
function connectConversationEvents(){
  if(handoverOnlyMode||!hasCapability('conversations:read_assigned')||document.hidden||!window.EventSource)return;
  if(conversationEvents)return;
  conversationEvents=new EventSource('/api/local/conversation-events');
  conversationEvents.addEventListener('conversations',()=>{void syncAcquisitionCustomers();});
  conversationEvents.addEventListener('sync-error',()=>{ui.conversationSyncError='实时同步暂时中断，正在重连';});
}
function disconnectConversationEvents(){conversationEvents?.close();conversationEvents=null;}
window.addEventListener('pagehide',disconnectConversationEvents);
document.addEventListener('visibilitychange',()=>{if(document.hidden)disconnectConversationEvents();else connectConversationEvents();});
window.addEventListener('focus',connectConversationEvents);
setTimeout(connectConversationEvents,1000);

document.addEventListener('scroll',event=>{
  if(event.target?.matches?.('.chat-body') && event.target.scrollHeight-event.target.scrollTop-event.target.clientHeight<48){
    const current=store.conversation(ui.conversationId);
    if(current&&conversationReads.unread(current)){conversationReads.markRead(current);updateReceptionWindow();}
  }
},true);
