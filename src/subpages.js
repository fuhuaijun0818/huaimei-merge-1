import { store } from "./store.js";
import { stageSteps } from "./data.js";
import { icon } from "./icons.js";
import { avatar, badge, card, customerCell, empty, escapeHtml, formatDate, metric, pageHead, physicianAvatar, relativeTime } from "./ui.js";

export const moduleNavConfig = {
  workbench: [["overview", "总览"], ["team", "团队工作台"], ["approvals", "待人工确认"], ["takeovers", "人工接管队列"]],
  customers: [["overview", "客户列表"], ["lifecycle", "生命周期看板"], ["segments", "动态分群"], ["ownership", "归属与共享池"], ["duplicates", "重复客户合并"]],
  conversations: [["overview", "会话收件箱"], ["takeovers", "人工接管"], ["quality", "会话质检"], ["bad-cases", "Bad Case库"], ["templates", "常用话术库"]],
  journeys: [["overview", "旅程列表"], ["templates", "模板库"], ["instances", "客户旅程进度"], ["review", "效果复盘"]],
  agents: [["overview", "AI员工列表"], ["logs", "执行记录"], ["evaluations", "效果与安全测试"], ["versions", "版本管理"], ["api", "API开放平台"]],
  physicians: [["overview", "医师团队"], ["specialties", "领域总览"], ["avatar", "AI分身工作室"]],
  knowledge: [["overview", "知识库"], ["rules", "合规规则"], ["audit", "回答追溯"], ["evaluations", "知识与回答测试"]],
  catalog: [["overview", "产品管理"]],
  analytics: [["overview", "经营总览"], ["lifecycle", "生命周期"], ["channels", "渠道与项目"], ["collaboration", "人机协作"], ["journeys", "旅程分析"], ["quality", "数据质量"]],
  integrations: [["overview", "本地数据服务"], ["organization", "组织与人员"], ["permissions", "权限与审计"]],
  administration: [["overview", "用户管理"], ["roles", "角色管理"], ["permissions", "权限管理"], ["audit", "操作审计"]]
};

// 与左侧的一级工作域保持同一套命名，页面中的横向导航只承担当前模块的
// 二级操作入口，避免同一功能在不同位置使用不同的分类名称。
const moduleMeta = {
  workbench: ["总览", "今日工作台"], customers: ["客户运营", "客户与会员"],
  conversations: ["客户运营", "会话与接待"], journeys: ["客户运营", "自动化运营"],
  agents: ["服务内容与智能体", "智能体中心"], physicians: ["服务内容与智能体", "医师团队"], knowledge: ["服务内容与智能体", "知识与合规"],
  catalog: ["服务内容与智能体", "项目与价格"], analytics: ["经营治理", "经营分析"], integrations: ["经营治理", "系统配置"],
  administration: ["经营治理", "组织与权限"]
};

const entityMeta = {
  task: ["workbench", "任务详情"], conversation: ["conversations", "会话详情"], segment: ["customers", "动态分群详情"],
  journey: ["journeys", "旅程编排"], agent: ["agents", "AI员工详情"], physician: ["physicians", "医师详情"], "knowledge-item": ["knowledge", "知识条目详情"], connector: ["integrations", "连接器详情"]
};

export const entityNavRoute = (route) => entityMeta[route]?.[0] || route;

// 一期售前人员只在客户与会话工作台处理已进入接待队列的会话。
// 二级导航在前端收敛用于降低误操作；服务端 capability 仍是最终授权边界。
const isPhaseOnePresales = () => /售前|销售|咨询/.test(String(store.state.currentRole || ""));
const presalesSubnavKeys = Object.freeze({
  workbench: new Set(["overview", "takeovers"]),
  customers: new Set(["overview"]),
  conversations: new Set(["overview", "takeovers", "templates"])
});

export const entityTitle = (route, id) => {
  if (route === "task") return store.task(id)?.title || "任务详情";
  if (route === "conversation") return store.customer(store.conversation(id)?.customerId)?.name || "会话详情";
  if (route === "journey") return store.state.journeys.find((item) => item.id === id)?.name || "旅程编排";
  if (route === "agent") return store.state.agents.find((item) => item.id === id)?.name || "AI员工详情";
  if (route === "physician") return store.physician(id)?.name || "医师详情";
  if (route === "knowledge-item") return store.state.knowledge.find((item) => item.id === id)?.title || "知识条目详情";
  if (route === "connector") return store.state.connectors.find((item) => item.id === id)?.name || "连接器详情";
  if (route === "segment") return configurationRecords("segment").find((item) => item.id === id)?.name || "动态分群详情";
  return entityMeta[route]?.[1] || id;
};

export const moduleSubnav = (route, active = "overview") => {
  const allItems = moduleNavConfig[route];
  const items = isPhaseOnePresales() && presalesSubnavKeys[route]
    ? allItems?.filter(([key]) => presalesSubnavKeys[route].has(key))
    : allItems;
  if (!items) return "";
  return `<nav class="module-subnav" aria-label="${moduleMeta[route][1]}二级导航">${items.map(([key, label]) => {
    const isActive = active === key || (!active && key === "overview");
    return `<a class="module-subnav-item ${isActive ? "active" : ""}" href="#/${route}${key === "overview" ? "" : `/${key}`}" ${isActive ? 'aria-current="page"' : ""}>${label}</a>`;
  }).join("")}</nav>`;
};

const table = (heads, rows, className = "") => `<div class="table-wrap ${className}"><table class="data-table"><thead><tr>${heads.map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const progress = (value, label = `${value}%`) => `<div class="progress-cell"><div class="progress"><span style="width:${Math.min(100, value)}%"></span></div><strong>${label}</strong></div>`;
const actionLink = (label, route, id) => `<button class="link" data-entity="${route}" data-id="${id}">${label}</button>`;
const subpage = (route, key, title, desc, body, actions = "") => `<div class="page">${pageHead(moduleMeta[route][0], title, desc, actions)}${moduleSubnav(route, key)}${body}</div>`;
const knowledgeStageLabel = (value) => ({ L0: "原始资料", L1: "内容整理", L2: "医务审核", L3: "合规审核", L4: "正式启用" }[value] || value || "待确认");
const riskLabel = (value, detail = "") => detail || ({ H3: "高风险", H2: "中风险", H1: "一般风险" }[value] || value || "待评估");

// 一期没有接入 CRM、收银或外部预约系统。经营页只展示当前系统内已经
// 建档的数据，不用示例大盘数字填充，避免与客户、会话和任务模块口径不一致。
const managementMetrics = () => {
  const customers = store.state.customers || [];
  const tasks = store.state.tasks || [];
  const conversations = store.state.conversations || [];
  const countBy = (items, keyOf) => items.reduce((result, item) => {
    const key = keyOf(item) || "未分类";
    result.set(key, (result.get(key) || 0) + 1);
    return result;
  }, new Map());
  const macroStages = countBy(customers, (item) => item.macroStage);
  const channels = countBy(customers, (item) => item.latestChannel || item.firstChannel || item.source);
  const projects = countBy(customers.flatMap((item) => item.interests || []), (item) => item.projectRef?.name || item.name);
  const openTasks = tasks.filter((item) => !["已完成", "已取消"].includes(item.status));
  const urgentTasks = openTasks.filter((item) => item.priority === "紧急" || item.status === "已超时");
  const humanConversations = conversations.filter((item) => ["待人工", "人工处理中"].includes(item.status));
  return { customers, tasks, conversations, macroStages, channels, projects, openTasks, urgentTasks, humanConversations };
};

const runtimeJourneyMetrics = () => new Map((store.state.journeys || []).map((journey) => [journey.id, {
  total:Number(journey.runtimeMembers || 0),
  running:Number(journey.runtimeRunningMembers || 0),
  paused:Number(journey.runtimePausedMembers || 0)
}]));

const runtimeAgentMetrics = () => new Map((store.state.agents || []).map((agent) => [agent.id, {
  customers:Number(agent.runtimeActiveCustomers || 0),
  conversations:Number(agent.runtimeConversationCount || 0),
  openTasks:Number(agent.runtimeOpenTaskCount || 0)
}]));

const percent = (part, total) => total ? Math.round(part / total * 100) : 0;

const configurationRecords = (kind) => (store.state.configurationRecords || []).filter((item) => item.kind === kind);
const isPhaseOneAdministrator = () => ["管理员", "管理者"].includes(store.state.currentRole);

const segmentMembers = (segment, customers = store.state.customers || []) => {
  const criteria = segment.criteria || {};
  return customers.filter((customer) => {
    if (criteria.macroStage && customer.macroStage !== criteria.macroStage) return false;
    if (criteria.microStage && customer.microStage !== criteria.microStage) return false;
    if (criteria.project && !(customer.interests || []).some((item) => (item.projectRef?.name || item.name) === criteria.project)) return false;
    if (criteria.minScore && !(customer.interests || []).some((item) => Number(item.score || 0) >= Number(criteria.minScore))) return false;
    return true;
  });
};

function teamWorkbench() {
  const metrics = managementMetrics();
  const assignees = [...new Set(metrics.tasks.map((item) => item.assignee).filter(Boolean))];
  const workload = table(["处理人", "所属团队", "待办", "超时/紧急", "关联客户", "状态"], assignees.map((name) => {
    const tasks = metrics.openTasks.filter((item) => item.assignee === name);
    const user = (store.state.managementUsers || []).find((item) => item.name === name);
    const relatedCustomers = new Set(tasks.map((item) => item.customerId).filter(Boolean)).size;
    const risk = tasks.filter((item) => item.priority === "紧急" || item.status === "已超时").length;
    return [`<strong>${escapeHtml(name)}</strong>`, escapeHtml(user?.department || "未配置后台组织"), tasks.length, badge(risk, risk ? "danger" : "success"), relatedCustomers, badge(tasks.length ? "有待处理" : "当前无待办", tasks.length ? "warning" : "success")];
  }));
  return subpage("workbench", "team", "团队工作台", "按客户阶段查看人员与AI的当日工作量，优先处理风险、即将超时的事项和客户机会。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("当前待办", String(metrics.openTasks.length), "任务模块统一口径", "users")}${metric("紧急或已超时", String(metrics.urgentTasks.length), "需要优先处理", "alert")}${metric("待人工接管", String(metrics.humanConversations.length), "会话模块统一口径", "bot")}${metric("已配置处理人", String(assignees.length), "来自当前任务分配", "chart")}</div><div class="grid detail-grid"><section class="card">${workload}</section>${card("任务分配校验", `<div class="policy-list"><div class="policy-row"><div><strong>待分配任务</strong><span>尚未指派具体处理人</span></div>${badge(String(metrics.openTasks.filter((item) => !item.assignee).length), metrics.openTasks.some((item) => !item.assignee) ? "warning" : "success")}</div><div class="policy-row"><div><strong>未配置组织的处理人</strong><span>需补充后台用户或组织归属</span></div>${badge(String(assignees.filter((name) => !(store.state.managementUsers || []).some((item) => item.name === name)).length), "warning")}</div><div class="policy-row"><div><strong>实时排班</strong><span>当前阶段尚未接入排班系统，不虚构班次与缺口</span></div>${badge("待接入", "outline")}</div></div><button class="btn small primary" style="margin-top:14px" data-action="create-insight-task">生成改进任务</button>`, { subtitle: "基于当前任务、会话和组织档案" })}</div>`);
}

function approvalQueue() {
  const taskApprovals = (store.state.tasks || []).filter((item) => item.status === "待审批").map((item) => ["客户动作", item.title, item.source || "系统", item.assignee || "待分配", item.type || "待审批", item.priority === "紧急" ? "高" : item.priority === "高" ? "中" : "低", `task:${item.id}`]);
  const productApprovals = (store.state.products || []).filter((item) => item.approvalStatus && item.approvalStatus !== "已通过" && item.price).slice(0, 20).map((item) => ["价格核验", item.name, item.owner || "待分配", "业务、医务与合规", item.priceType || "资料参考价", "中", `product:${item.id}`]);
  const approvals = [...taskApprovals, ...productApprovals];
  const high = approvals.filter((item) => item[5] === "高").length;
  return subpage("workbench", "approvals", "待人工确认", "客户触达、跟进策略、高风险内容和价格核验，需要由对应负责人确认后才能执行。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("待人工确认", String(approvals.length), "任务与价格核验的当前记录", "shield")}${metric("高风险待审", String(high), "按记录风险等级统计", "alert")}${metric("内部知识草稿", "实时", "对客使用须完成正式发布", "database")}${metric("价格待核验", String(productApprovals.length), "参考价不等同当前报价", "clock")}</div><section class="card">${approvals.length ? table(["审批类型", "审批内容", "提交者", "审批责任人", "动作", "风险", "操作"], approvals.map((row) => { const [kind, recordId] = String(row[6] || "").split(":"); const action = kind === "task" ? actionLink("查看任务", "task", recordId) : kind === "product" ? `<button class="btn small" data-action="edit-product" data-id="${escapeHtml(recordId)}">维护产品</button>` : "—"; return [...row.slice(0,5), badge(row[5], row[5] === "高" ? "danger" : row[5] === "中" ? "warning" : "success"), action]; })) : empty("当前没有待人工确认事项", "产生价格核验或待审批任务后会在此显示")}</section>`);
}

function takeoverQueue() {
  const items = store.state.conversations.filter((item) => ["待人工", "人工处理中"].includes(item.status));
  const rows = items.map((conversation, index) => {
    const customer = store.customer(conversation.customerId);
    return [customerCell(customer), badge(`${customer.macroStage}/${customer.microStage}`, "outline"), conversation.channel, conversation.lastMessage, badge(index ? "5分钟" : "28分钟", index ? "warning" : "danger"), customer.owner, actionLink("进入会话", "conversation", conversation.id)];
  });
  return subpage("workbench", "takeovers", "人工接管队列", "医疗边界、异常描述、投诉和AI把握不足的问题优先交由人工处理，并保留AI停止回答的位置。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("当前接管队列", String(items.length), "会话状态为待人工或人工处理中", "alert")}${metric("医疗边界任务", String((store.state.tasks || []).filter((item) => /医疗边界|适用性/.test(item.reason || item.title || "")).length), "任务模块关联统计", "shield")}${metric("未读客户消息", String(items.reduce((sum, item) => sum + Number(item.unread || 0), 0)), "当前会话记录", "message")}${metric("已完成接管任务", String((store.state.tasks || []).filter((item) => item.type === "AI转人工" && item.status === "已完成").length), "只统计已记录任务", "check")}</div><section class="card">${rows.length ? table(["客户", "当前环节", "渠道", "触发内容", "等待", "责任人", "操作"], rows) : empty("当前没有待接管会话", "AI将在命中边界时自动创建接管任务")}</section>`);
}

function lifecycleBoard() {
  const metrics = managementMetrics();
  const columns = Object.entries(stageSteps).flatMap(([macro, steps]) => steps.map((step) => ({ macro, step, customers: store.state.customers.filter((customer) => customer.macroStage === macro && customer.microStage === step) }))).filter((item) => item.customers.length || ["留资待预约", "到院面诊", "普通随访", "复购窗口"].includes(item.step));
  return subpage("customers", "lifecycle", "生命周期看板", "管理者从售前、售中、售后三大阶段下钻到微环节，直接定位停滞、责任人和下一步策略。",
    `<div class="lifecycle-summary">${["售前","售中","售后"].map((stage) => { const total = metrics.macroStages.get(stage) || 0; const focus = metrics.customers.filter((item) => item.macroStage === stage && ["留资待预约", "到院面诊", "复购窗口"].includes(item.microStage)).length; return `<div class="lifecycle-summary-card"><div class="row between"><strong>${stage}</strong>${badge(`${stageSteps[stage].length}个环节`,stage)}</div><div class="metric-value">${total}</div><div class="caption">重点环节 ${focus}人</div></div>`; }).join("")}</div><div class="lifecycle-board">${columns.map((column) => `<section class="stage-column"><header><div><strong>${column.step}</strong><span>${column.macro}</span></div>${badge(column.customers.length || "—", "outline")}</header><div class="stack">${column.customers.map((customer) => `<article class="stage-customer"><div class="row">${avatar(customer,"sm")}<div><button class="link" data-customer="${customer.id}">${customer.name}</button><div class="caption">${customer.owner} · 健康度 ${customer.health}</div></div></div><div class="row between"><span class="caption">${customer.interests[0]?.name || "待识别"} ${customer.interests[0]?.score || 0}</span>${badge(customer.sla, customer.sla.includes("超时") ? "danger" : "success")}</div><div class="stage-action">${customer.nextAction.title}</div></article>`).join("") || `<div class="stage-empty">暂无样本客户</div>`}</div></section>`).join("")}</div>`);
}

function segmentList() {
  const metrics = managementMetrics();
  const segments = configurationRecords("segment");
  const memberCounts = segments.map((segment) => segmentMembers(segment, metrics.customers).length);
  return subpage("customers", "segments", "动态分群", "客户信息、兴趣、授权或阶段变化后，分群会自动更新，并可用于安排任务、客户旅程和经营分析。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("分群规则", String(segments.length), "服务端持久化配置", "filter")}${metric("命中客户", String(memberCounts.reduce((sum, count) => sum + count, 0)), "同一客户可命中多个分群", "users")}${metric("已关联旅程", String([...new Set(segments.map((item) => item.journeyId).filter(Boolean))].length), "仅统计已选择旅程", "route")}${metric("待复核规则", String(segments.filter((item) => item.status !== "启用").length), "草稿或停用配置", "alert")}</div>${segments.length ? `<div class="segment-grid">${segments.map((segment) => { const members = segmentMembers(segment, metrics.customers); const journey = store.state.journeys.find((item) => item.id === segment.journeyId); return `<article class="card segment-card"><div class="row between">${badge(segment.status || "草稿", segment.status === "启用" ? "success" : "outline")}${badge(segment.owner || "未分配", "outline")}</div><h3>${escapeHtml(segment.name)}</h3><p>${escapeHtml(segment.rule || "未填写规则说明")}</p><div class="segment-kpis"><div><strong>${members.length}</strong><span>当前客户</span></div><div><strong>${percent(members.length, metrics.customers.length)}%</strong><span>占已建档客户</span></div><div><strong>${members.length ? "已命中" : "暂无"}</strong><span>当前计算结果</span></div></div><div class="divider"></div><div class="row between"><span class="caption">关联：${escapeHtml(journey?.name || "未关联旅程")}</span><button class="link" data-action="edit-segment" data-id="${escapeHtml(segment.id)}">编辑</button></div></article>`; }).join("")}</div>` : empty("暂无动态分群", "新建分群后，系统会根据已保存的阶段、项目和兴趣分数实时计算成员。")}`, `<button class="btn primary" data-action="new-segment">${icon("plus",15)}新建分群</button>`);
}

function ownershipPage() {
  const metrics = managementMetrics();
  const owners = [...new Set(metrics.customers.map((item) => item.owner).filter(Boolean))].map((name) => {
    const customers = metrics.customers.filter((item) => item.owner === name);
    const overdue = customers.filter((item) => String(item.sla || "").includes("超时")).length;
    const department = store.state.managementUsers.find((item) => item.name === name)?.department || "待补充组织归属";
    return [name, department, customers.length, customers.filter((item) => item.nextAction?.status === "进行中").length, overdue, Math.min(100, customers.length * 20)];
  });
  const assigned = metrics.customers.filter((item) => item.owner).length;
  return subpage("customers", "ownership", "归属与共享池", "明确人工主责、协作AI和客户转派记录，避免重复跟进和客户失联。当前阶段不自动轮转、回收或批量转派客户。",
    `<div class="grid cols-3" style="margin-bottom:16px">${metric("有明确归属", String(assigned), `${metrics.customers.length ? Math.round(assigned / metrics.customers.length * 100) : 0}%覆盖`, "users")}${metric("共享池待分配", String(metrics.customers.length - assigned), "未自动分配", "refresh")}${metric("超时风险客户", String(metrics.customers.filter((item) => String(item.sla || "").includes("超时")).length), "由负责人优先处理", "route")}</div><div class="grid detail-grid"><section class="card">${table(["负责人", "团队", "归属客户", "进行中", "超时风险", "工作负荷"], owners.map(([name,team,total,today,risk,load]) => [`<strong>${name}</strong>`,team,total,today,badge(risk,risk ? "danger":"success"),progress(load)]))}</section>${card("共享池自动化", empty("尚未配置自动共享池规则", "当前不会自动转派或回收客户；请在客户档案中通过“变更责任人”完成有依据的人工转派。"))}</div>`);
}

function duplicatesPage() {
  return subpage("customers", "duplicates", "重复客户合并", "可靠身份信息一致时可自动建议；涉及医疗、交易、投诉等记录时必须人工复核，并支持拆分恢复。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("系统内客户", String((store.state.customers || []).length), "当前以客户编号作为唯一主键", "users")}${metric("重复主键", String((store.state.dataQualityReport?.issues || []).filter((item) => item.domain === "客户" && item.code === "duplicate_id").reduce((sum, item) => sum + item.count, 0)), "发现即阻断自动关联", "alert")}${metric("待合并候选", "0", "一期未接入外部身份源，不猜测合并", "refresh")}${metric("可回滚合并", "待接入", "后续需由合并审计流水支撑", "check")}</div><section class="card">${empty("当前没有可自动合并的客户候选", "一期仅用客户编号建立系统内身份关系；姓名、照片、项目兴趣和脱敏手机号均不会触发自动合并。")}</section>`);
}

function conversationTakeovers() {
  const metrics = managementMetrics();
  const rows = store.state.conversations.filter((item) => ["待人工", "人工处理中"].includes(item.status)).map((conversation,index) => {
    const customer = store.customer(conversation.customerId);
    return [customerCell(customer),badge(`${customer.macroStage}/${customer.microStage}`,"outline"),conversation.channel,conversation.lastMessage,badge(index?"5分钟":"28分钟",index?"warning":"danger"),customer.owner,actionLink("进入会话","conversation",conversation.id)];
  });
  return subpage("conversations","takeovers","人工接管队列","医疗边界、异常描述、投诉和AI把握不足的问题优先交由人工处理，并保留AI停止回答的位置。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("等待接管",String(rows.length),"当前系统内会话","alert")}${metric("高优先任务",String(metrics.urgentTasks.length),"按任务状态统计","clock")}${metric("已完成任务",String(metrics.tasks.filter((item) => item.status === "已完成").length),"本地任务记录","check")}${metric("会话总数",String(metrics.conversations.length),"不推测外部渠道数据","shield")}</div><section class="card">${rows.length?table(["客户","当前环节","渠道","触发内容","等待","责任人","操作"],rows):empty("当前没有待接管会话","AI将在命中边界时自动创建接管任务")}</section>`);
}

function conversationQuality() {
  const metrics = managementMetrics();
  const samples = metrics.conversations.map((conversation) => {
    const customer = store.customer(conversation.customerId);
    const needsReview = ["待人工", "人工处理中", "待审批"].includes(conversation.status);
    return [conversation.id, customer?.name || "客户待关联", conversation.channel || "未记录", conversation.lastMessage || "暂无客户消息", needsReview ? "待复核" : "已归档"];
  });
  return subpage("conversations", "quality", "会话质检", "按知识正确性、医疗边界、合规表达、服务完整性和客户推进效果对会话评分。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("待质检会话", String(samples.filter((item) => item[4] === "待复核").length), "需要人工判断", "message")}${metric("已归档会话", String(samples.filter((item) => item[4] === "已归档").length), "当前本地会话记录", "chart")}${metric("已记录Bad Case", "以Bad Case库为准", "仅统计已反馈问题", "shield")}${metric("待复核", String(samples.filter((item) => item[4] === "待复核").length), "不生成虚构质检分数", "alert")}</div><section class="card">${samples.length ? table(["客户", "渠道", "最近内容", "质检状态", "详情"], samples.map(([id,name,channel,message,status]) => [name,channel,message,badge(status,status === "已归档" ? "success":"warning"),actionLink("查看会话", "conversation", id)])) : empty("暂无会话记录", "客户开始咨询后将在此进入质检流程")}</section>`);
}

function conversationBadCases({ badCases = [], badCasesLoading = false, badCasesError = "" } = {}) {
  const statusMeta = {
    new:["待分析", "danger"],
    triaged:["已归类", "warning"],
    included_in_eval:["已纳入评测", "success"],
    dismissed:["已忽略", "outline"]
  };
  const statusBadge = (status) => badge(statusMeta[status]?.[0] || "待分析", statusMeta[status]?.[1] || "outline");
  const latest = (item, role) => [...(item.transcript || [])].reverse().find((message) => message.role === role)?.content || "—";
  const newCount = badCases.filter((item) => item.status === "new").length;
  const triagedCount = badCases.filter((item) => item.status === "triaged").length;
  const includedCount = badCases.filter((item) => item.status === "included_in_eval").length;
  const body = badCasesLoading
    ? `<div class="card padded"><div class="empty">正在同步客户“踩”反馈…</div></div>`
    : badCasesError
      ? `<div class="risk-banner">${icon("alert",15)}<div><strong>Bad Case队列暂时无法读取</strong><br/>未展示缓存为成功，请检查服务连接后重试。</div></div>`
      : badCases.length
        ? `<section class="card">${table(["反馈时间", "渠道", "客户关注点", "智能体回答", "状态", "操作"], badCases.map((item) => [
          formatDate(item.updated_at || item.created_at),
          escapeHtml(item.channel || "web"),
          escapeHtml(latest(item, "user").slice(0, 42)),
          escapeHtml(latest(item, "assistant").slice(0, 58)),
          statusBadge(item.status),
          `<div class="row wrap"><button class="link" data-action="view-bad-case" data-id="${escapeHtml(item.id)}">查看对话</button>${item.status === "new" || item.status === "triaged" ? `<button class="link" data-action="review-bad-case" data-id="${escapeHtml(item.id)}" data-status="included_in_eval">纳入评测</button>` : ""}${item.status === "new" ? `<button class="link" data-action="review-bad-case" data-id="${escapeHtml(item.id)}" data-status="dismissed">忽略</button>` : ""}</div>`
        ]))}</section>`
        : empty("还没有客户标记为“不准确”的回答", "客户在前台点击“踩”后，会自动带着脱敏上下文进入这里，供统一复盘与评测优化。");
  return subpage("conversations", "bad-cases", "Bad Case库", "集中复盘客户认为不准确或不符合预期的回答。每条记录包含已脱敏的可见对话，处理后可纳入回归评测集。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("待分析", String(newCount), "需要判断问题类型与修复方向", "alert")}${metric("已归类", String(triagedCount), "等待补充标签或修复方案", "filter")}${metric("已纳入评测", String(includedCount), "下次模型、提示词或知识变更必须回归", "check")}${metric("当前队列", String(badCases.length), "仅记录客户主动点击“踩”的会话", "message")}</div>${body}`,
    `<button class="btn" data-action="refresh-bad-cases" ${badCasesLoading ? "disabled" : ""}>${icon("refresh",15)}${badCasesLoading ? "正在同步" : "刷新队列"}</button>`);
}

function conversationTemplates() {
  const templates = configurationRecords("message_template");
  const canManage = isPhaseOneAdministrator();
  const visibleTemplates = canManage ? templates : templates.filter((item) => item.presalesVisible !== false);
  const useLabel = (item) => item.status === "启用" && item.presalesInsertable !== false
    ? badge("会话窗口可插入", "success")
    : badge(item.executionMode || "仅查看", item.executionMode === "强制转人工" ? "danger" : "outline");
  const actionCell = (item) => canManage
    ? `<button class="link" data-action="edit-message-template" data-id="${escapeHtml(item.id)}">编辑</button>`
    : (item.status === "启用" && item.presalesInsertable !== false ? "<span class=\"caption\">在会话窗口插入</span>" : "<span class=\"caption\">暂不可插入</span>");
  return subpage("conversations", "templates", "常用话术库", "已启用的话术模板可由售前人员查看，并在内部会话窗口插入后再结合当前客户情况发送；模板本身不会自动对外发送。管理员负责维护模板内容与启用状态。",
    visibleTemplates.length ? `<section class="card">${table(["话术模板", "适用环节", "使用方式", "状态", "更新时间", "操作"], visibleTemplates.map((item) => [`<strong>${escapeHtml(item.name)}</strong>`,escapeHtml(item.scope || "未填写"),useLabel(item),badge(item.status || "草稿", item.status === "启用" ? "success" : "warning"),relativeTime(item.updatedAt),actionCell(item)]))}</section>` : empty("暂无可用话术模板", canManage ? "请按真实业务场景新建模板；启用后，售前人员即可在会话窗口查看和插入。" : "管理员启用话术后，会在这里提供给售前人员查看和插入。"), canManage ? `<button class="btn primary" data-action="new-message-template">${icon("plus",15)}新建话术模板</button>` : `<span class="caption">仅展示可用于当前售前会话的已授权话术</span>`);
}

function journeyTemplatePage() {
  const templates = configurationRecords("journey_template");
  return subpage("journeys", "templates", "旅程模板库", "模板由运营人员维护为草稿，使用模板只会新建一条本地旅程草稿；不会自动触达客户或改变已有旅程。",
    templates.length ? `<div class="template-grid">${templates.map((item) => `<article class="card template-card"><div class="row between">${badge(item.stage || "未分类",item.stage || "outline")}${badge(item.status || "草稿",item.status === "启用" ? "success" : "outline")}</div><div class="template-icon">${icon("route",22)}</div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml((item.nodes || []).join(" → ") || item.description || "未填写流程步骤")}</p><div class="row between"><span class="caption">步骤 ${(item.nodes || []).length} 个</span><button class="link" data-action="edit-journey-template" data-id="${escapeHtml(item.id)}">编辑</button></div><button class="btn small primary" data-action="use-journey-template" data-id="${escapeHtml(item.id)}" ${item.status === "启用" ? "" : "disabled"}>使用模板创建草稿</button></article>`).join("")}</div>` : empty("暂无旅程模板", "请先按真实运营流程新建并审核旅程模板。"), `<button class="btn primary" data-action="new-journey-template">${icon("plus",15)}新建模板</button>`);
}

function journeyInstances() {
  const rows = store.state.customers.flatMap((customer) => customer.journeys.map((member,index) => {
    const journey = store.state.journeys.find((item) => item.id === member.id);
    return [customerCell(customer), actionLink(journey?.name || member.name,"journey",member.id), badge(customer.macroStage), member.node, formatDate(customer.stageEnteredAt), badge(member.status, member.status === "运行中" ? "success" : "warning"), `<button class="link" data-customer="${customer.id}">客户360</button>`];
  }));
  const running = rows.filter((row) => row[5].includes("运行中")).length;
  const paused = rows.filter((row) => row[5].includes("暂停")).length;
  const metrics = managementMetrics();
  return subpage("journeys", "instances", "客户旅程进度", "逐客户查看当前旅程、所在环节、等待事项、人工任务和退出原因。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("已关联客户旅程", String(rows.length), "客户档案中的旅程关系", "route")}${metric("运行中", String(running), "按客户旅程状态统计", "check")}${metric("暂停", String(paused), "需人工检查原因", "alert")}${metric("关联待办", String(metrics.openTasks.filter((item) => item.source === "旅程").length), "任务模块统一口径", "users")}</div><section class="card">${rows.length ? table(["客户", "旅程", "阶段", "当前环节", "进入时间", "状态", "详情"], rows) : empty("暂无客户旅程关系", "客户进入旅程后会在此显示")}</section>`);
}

function journeyReview() {
  const runtime = runtimeJourneyMetrics();
  const totalAssignments = [...runtime.values()].reduce((sum, item) => sum + item.total, 0);
  const running = [...runtime.values()].reduce((sum, item) => sum + item.running, 0);
  const paused = [...runtime.values()].reduce((sum, item) => sum + item.paused, 0);
  const openJourneyTasks = managementMetrics().openTasks.filter((item) => item.source === "旅程").length;
  return subpage("journeys", "review", "旅程效果复盘", "不只看触达和打开：以阶段推进、目标完成、人工负担、合规和客户退出原因评价旅程。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("已关联客户旅程", String(totalAssignments), "客户档案运行事实", "route")}${metric("运行中关系", String(running), "当前状态", "users")}${metric("暂停关系", String(paused), "需要人工复核", "alert")}${metric("旅程待办", String(openJourneyTasks), "任务来源为旅程", "shield")}</div><div class="grid detail-grid"><section class="card">${table(["旅程", "阶段", "当前关联客户", "运行中", "暂停", "目标完成率", "操作"], store.state.journeys.map((journey) => { const item = runtime.get(journey.id) || { total:0, running:0, paused:0 }; return [actionLink(journey.name,"journey",journey.id),badge(journey.stage),item.total,item.running,badge(item.paused,item.paused ? "warning" : "success"),journey.conversion == null ? "待接入目标结果" : `${journey.conversion}%（配置目标）`,actionLink("查看画布", "journey", journey.id)]; }))}</section>${card("复盘口径", `<div class="policy-list"><div class="policy-row"><div><strong>当前可统计</strong><span>客户旅程关系、运行/暂停状态和任务关联</span></div>${badge("已启用", "success")}</div><div class="policy-row"><div><strong>暂不统计</strong><span>触达、成交、支付与到院结果尚未接入业务系统</span></div>${badge("不展示虚构数据", "outline")}</div></div>`, { subtitle: "当前系统运行数据" })}</div>`);
}

function agentLogs() {
  const metrics = managementMetrics();
  const agentNames = new Set((store.state.agents || []).map((item) => item.name));
  const logs = (store.state.audit || []).filter((item) => agentNames.has(item.actor)).map((item) => {
    const conversation = store.conversation(item.object);
    const customer = conversation ? store.customer(conversation.customerId) : store.customer(item.object);
    return [formatDate(item.at), item.actor, item.action, customer?.name || "未关联客户", item.result || "—", item.result === "成功" ? "成功" : "已记录", item.severity || "低", conversation?.id || "", item.id];
  });
  const runtime = runtimeAgentMetrics();
  const runtimeConversations = [...runtime.values()].reduce((sum, item) => sum + item.conversations, 0);
  const runtimeTasks = [...runtime.values()].reduce((sum, item) => sum + item.openTasks, 0);
  return subpage("agents", "logs", "AI执行记录", "每次查找知识、形成建议、联系客户、转人工或主动拦截，都会关联客户、所用知识、规则和责任人。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("已记录AI审计", String(logs.length), "审计表中的 AI 执行记录", "spark")}${metric("AI关联会话", String(runtimeConversations), "客户与会话关系校验后统计", "users")}${metric("AI关联待办", String(runtimeTasks), "未完成任务", "clock")}${metric("待人工接管", String(metrics.humanConversations.length), "会话状态口径", "shield")}</div><section class="card">${logs.length ? table(["时间", "AI员工", "动作", "客户", "依据/原因", "结果", "风险", "详情"], logs.map((row) => [...row.slice(0,6),badge(row[6],row[6]==="高"?"danger":row[6]==="中"?"warning":"success"),row[7] ? actionLink("查看会话","conversation",row[7]) : `<button class="link" data-action="view-audit" data-id="${escapeHtml(row[8] || "")}">查看审计</button>`])) : empty("暂无可追溯的AI执行审计", "AI完成工具调用、转人工或规则拦截后会在此显示")}</section>`);
}

function evaluationsPage(route = "agents", key = "evaluations") {
  const isAgent = route === "agents";
  const suites = isAgent ? [["医疗边界","强制≥98"],["项目知识","目标≥95"],["宣传表达","强制≥97"],["工具权限","强制100"],["转人工时机","目标≥95"],["多轮一致性","目标≥94"]] : [["引用可追溯","强制≥98"],["项目事实一致","目标≥95"],["禁用表达","强制≥99"],["版本命中","目标≥97"],["拒答完整性","强制≥98"],["来源时效性","目标≥94"]];
  return subpage(route,key,isAgent?"AI员工效果与安全测试":"知识与回答测试",isAgent?"AI员工调整后必须通过上线前测试、历史会话复核和小范围试用；未达到安全标准不能正式启用。":"通过固定测试场景和脱敏历史会话，复核知识正确性、来源、拒答和版本一致性。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("评测维度", String(suites.length), "生产门槛已配置", "check")}${metric("当前结果", "待写入", "需由评测流水线回填", "database")}${metric("待复测版本", "待识别", "未运行不虚构结果", "refresh")}${metric("阻断发布", "未判定", "需完成全部回归", "alert")}</div><div class="evaluation-grid">${suites.map(([name,gate]) => `<article class="card eval-card"><div class="row between"><div class="eval-icon">${icon("shield",18)}</div>${badge("待运行", "outline")}</div><h3>${name}</h3><div class="eval-score">—<span></span></div><div class="progress"><span style="width:0%"></span></div><div class="row between caption"><span>评测结果尚未回填</span><span>${gate}</span></div></article>`).join("")}</div><div class="guardrail" style="margin-top:16px">${icon("shield",14)}评测只能由固定回归集、线上真实问题集、对抗安全集、长对话集、工具执行集和人工盲评共同完成；页面不会把静态占位当作评测通过。</div>`);
}

function agentVersions() {
  const versions = (store.state.agents || []).map((agent) => [
    agent.name,
    (String(agent.knowledge || "未配置").match(/v[\d.]+/i) || ["—"])[0],
    agent.status,
    agent.runtimeActiveCustomers || 0,
    agent.runtimeConversationCount || 0,
    agent.id === "A-06" ? "合规负责人" : "对应业务团队",
    agent.id
  ]);
  return subpage("agents","versions","AI员工版本管理","岗位要求、知识范围、可用能力和安全规则共同形成一个可追溯版本；恢复旧版本不会影响历史记录。",
    `<div class="release-lane">${["待配置","上线前测试","历史会话复核","小范围试用","正式启用"].map((step,index) => `<div class="release-step"><span>${index+1}</span><strong>${step}</strong><small>${["岗位与知识范围","固定回归测试","脱敏历史会话","人工盯盘","双人审批"][index]}</small></div>`).join("")}</div><section class="card" style="margin-top:16px">${table(["AI员工", "知识版本", "当前状态", "服务客户", "关联会话", "责任人", "操作"], versions.map((row) => [`<strong>${row[0]}</strong>`,row[1],badge(row[2],row[2] === "运行中" ? "success" : "warning"),row[3],row[4],row[5],actionLink("查看岗位", "agent", row[6])]))}</section><div class="guardrail" style="margin-top:16px">${icon("shield",14)}评测得分和发布结论仅由评测流水线回填；当前未回填时不以旧演示分数替代。</div>`);
}

function agentApiPlatform() {
  const origin = location.origin;
  const endpoints = [
    ["GET", "/api/v1/agents", "查询六个AI员工及能力边界", "发现"],
    ["GET", "/api/v1/model/status", "查询大模型运行时状态", "模型"],
    ["POST", "/api/v1/agents/{agentId}/invoke", "调用指定AI员工", "执行"],
    ["POST", "/api/v1/router/invoke", "按生命周期和意图自动路由", "编排"],
    ["POST", "/api/v1/compliance/check", "独立调用合规守门员", "门禁"],
    ["GET", "/api/v1/runs", "查询脱敏运行审计", "审计"],
    ["GET", "/api/v1/openapi.json", "OpenAPI 3.1接口规范", "文档"]
  ];
  const curl = [
    `curl -X POST '${origin}/api/v1/agents/A-01/invoke' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'X-API-Key: <LOCAL_API_KEY>' \\`,
    `  -H 'Idempotency-Key: <UNIQUE_REQUEST_KEY>' \\`,
    `  -d '{"customer_id":"<已建档客户ID>","message":"<客户消息>","mode":"assist","context":{"macro_stage":"售前","marketing_consent":true}}'`
  ].join("\n");
  return subpage("agents", "api", "AI员工 API开放平台", "本地服务提供统一智能体协议。调用前必须填写当前环境配置的 API Key；所有调用经过鉴权、限流、幂等、合规门禁与脱敏审计。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("后台登记AI员工", String((store.state.agents || []).length), "以本地管理数据为准", "bot")}${metric("模型运行时", `<span id="llm-runtime-value">...</span>`, `<span id="llm-runtime-detail">正在读取本地配置</span>`, "spark")}${metric("默认模型", `<span id="llm-model-name">未读取</span>`, `<span id="llm-provider-name">正在读取运行时</span>`, "database")}${metric("调用门禁", "已启用", "以接口响应为准", "shield")}</div>
    <div class="grid api-overview-grid"><section class="card"><div class="card-head"><div><div class="card-title">接口目录</div><div class="card-subtitle">JSON over HTTP(S) · 生产必须HTTPS · UTF-8 · 统一结构化错误</div></div><a class="btn small" href="/api/v1/openapi.json" target="_blank">${icon("download",14)}OpenAPI JSON</a></div>${table(["方法","路径","说明","能力"], endpoints.map(([method,path,desc,type]) => [badge(method,method==="POST"?"brand":"success"),`<code>${path}</code>`,desc,badge(type,"outline")]))}</section>
      <aside class="card padded api-security-card"><div class="card-title">接入安全</div><div class="api-security-list"><div>${icon("shield",16)}<span><strong>X-API-Key</strong><small>由本地环境变量或密钥管理服务配置并轮换</small></span></div><div>${icon("refresh",16)}<span><strong>Idempotency-Key</strong><small>同路径10分钟内避免重复执行</small></span></div><div>${icon("clock",16)}<span><strong>限流与Request ID</strong><small>具体阈值以服务响应头为准</small></span></div><div>${icon("eye",16)}<span><strong>最小化审计</strong><small>手机号自动脱敏，不保存完整客户上下文</small></span></div></div><div class="risk-banner">${icon("alert",14)}测试台不内置密钥。请输入当前本地环境的有效 API Key；生产环境必须使用单独密钥并轮换。</div></aside></div>
    <section class="card api-console" style="margin-top:16px"><div class="card-head"><div><div class="card-title">本地调用测试台</div><div class="card-subtitle">直接调用当前本地 API；成功响应会返回 run_id 并进入运行审计</div></div>${badge("LOCAL API","success")}</div><div class="api-console-grid"><div class="api-request-panel"><label class="form-group"><span class="form-label">选择AI员工</span><select class="form-control" id="api-agent-id">${store.state.agents.length ? store.state.agents.map((agent)=>`<option value="${agent.id}">${agent.id} · ${agent.name}</option>`).join("") : `<option value="A-01">A-01 · 由运行时校验</option>`}</select></label><div class="form-grid"><label class="form-group"><span class="form-label">关联本地客户（选填）</span><select class="form-control" id="api-customer-id"><option value="">不关联客户档案</option>${(store.state.customers || []).map((customer) => `<option value="${customer.id}">${escapeHtml(customer.name || customer.id)} · ${customer.id}</option>`).join("")}</select></label><label class="form-group"><span class="form-label">调用模式</span><select class="form-control" id="api-mode"><option value="assist">assist · 内部辅助</option><option value="reply">reply · 客户回复</option><option value="outbound">outbound · 主动触达</option></select></label><label class="form-group"><span class="form-label">客户阶段</span><select class="form-control" id="api-stage"><option>售前</option><option>售中</option><option>售后</option></select></label></div><label class="form-group"><span class="form-label">客户消息/任务</span><textarea class="form-control" id="api-message" placeholder="输入将要验证的客户问题或内部任务"></textarea></label><label class="api-check"><input type="checkbox" id="api-marketing-consent"/>营销触达授权有效（仅outbound模式使用）</label><label class="form-group"><span class="form-label">本地 API Key</span><input class="form-control" id="api-key" value="" placeholder="输入当前环境 API Key" autocomplete="off"/></label><div class="row"><button class="btn primary" data-action="api-run-test">${icon("arrow",14)}调用智能体</button><button class="btn" data-action="api-use-router">自动路由调用</button></div></div><div class="api-response-panel"><div class="row between"><span class="form-label">API响应</span><span id="api-response-status">等待调用</span></div><pre id="api-response">{
  "提示": "填写有效 API Key 与测试问题后再发起调用",
  "医疗诊断": false,
  "数据环境": "本地服务"
}</pre></div></div></section>
    <section class="card api-code-card" style="margin-top:16px"><div class="card-head"><div><div class="card-title">cURL示例</div><div class="card-subtitle">生产环境请替换Base URL与API Key</div></div><button class="btn small" data-action="copy-api-curl">${icon("download",14)}复制命令</button></div><pre id="api-curl-example">${escapeHtml(curl)}</pre></section>`, `<a class="btn" href="/api/health" target="_blank">健康检查</a><a class="btn primary" href="/api/v1/openapi.json" target="_blank">查看OpenAPI</a>`);
}

function knowledgeRules() {
  const rules = [["R-001","个体适用性/禁忌判断","医疗边界","强制转人工","L4","运行中"],["R-002","异常反应与用药","医疗安全","升级售后/医务","L4","运行中"],["R-003","绝对化效果承诺","宣传合规","拦截并重写","L4","运行中"],["R-004","照片授权失效","隐私授权","停止展示并记录","L4","运行中"],["R-005","客户联系频次","联系合规","延后联系或退出旅程","L3","运行中"]];
  const auditedBlocks = (store.state.audit || []).filter((item) => /拦截|医疗边界|合规/.test(`${item.actor} ${item.action} ${item.result}`)).length;
  return subpage("knowledge","rules","合规规则","规则在查找知识、形成回答和执行动作时持续生效；医疗边界与敏感信息规则不可被业务角色绕过。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("已配置规则", String(rules.length), "本地合规规则目录", "shield")}${metric("可追溯拦截", String(auditedBlocks), "审计记录中可识别的规则动作", "alert")}${metric("待复核判断", "待接入", "需由规则运行日志回填", "refresh")}${metric("覆盖AI员工", String((store.state.agents || []).length), "岗位均经过规则门禁", "bot")}</div><section class="card">${table(["规则", "适用范围", "命中后处理", "运行记录", "处理要求", "状态"], rules.map((row) => [row[1],row[2],row[3],"需接入规则运行审计",badge(row[4]==="L4"?"强制":"重要",row[4]==="L4"?"danger":"warning"),badge(row[5],"success")]))}</section>`);
}

function knowledgeAudit() {
  const audits = store.state.audit || [];
  const high = audits.filter((item) => item.severity === "高").length;
  const sensitive = audits.filter((item) => /照片|敏感|授权/.test(`${item.action} ${item.result}`)).length;
  return subpage("knowledge","audit","回答与动作追溯","从一次客户消息追溯到所用知识、触发规则、最终回复、人工接管与客户360更新。",
    `<div class="grid cols-3" style="margin-bottom:16px">${metric("审计记录", String(audits.length), "当前系统已写入", "database")}${metric("高风险事件", String(high), "均应有对应处理记录", "alert")}${metric("授权相关记录", String(sensitive), "按审计文字识别", "eye")}</div><section class="card">${audits.length ? table(["时间", "执行者", "动作", "业务对象", "结果", "风险", "处理记录"], audits.map((item) => [formatDate(item.at),item.actor,item.action,item.object.startsWith("V-")?"客户会话":item.object.startsWith("C-")?"客户档案":"业务记录",item.result,badge(item.severity,item.severity==="高"?"danger":item.severity==="中"?"warning":"success"),item.object.startsWith("V-")?actionLink("完整处理记录","conversation",item.object):`<button class="link" data-action="view-audit" data-id="${escapeHtml(item.id)}">查看记录</button>`])) : empty("暂无审计记录", "后台维护或智能体执行后会在此生成追溯记录")}</section>`);
}

function analyticsLifecycle() {
  const metrics = managementMetrics();
  const stages = Object.entries(stageSteps).flatMap(([macro, steps]) => steps.map((name) => {
    const count = metrics.customers.filter((item) => item.macroStage === macro && item.microStage === name).length;
    return [name, macro, count, metrics.customers.length ? Math.round(count / metrics.customers.length * 100) : 0];
  })).filter(([, , count]) => count > 0);
  const stalled = [
    ["价格顾虑", metrics.customers.filter((item) => (item.pains || []).some((pain) => /价格|预算/.test(pain))).length],
    ["适用性需面诊", metrics.tasks.filter((item) => /医疗边界|适用性/.test(item.reason || item.title || "")).length],
    ["联系时机不合适", metrics.customers.filter((item) => (item.pains || []).some((pain) => /恢复期|时间|工作/.test(pain))).length]
  ].filter(([, count]) => count > 0);
  return subpage("analytics","lifecycle","客户生命周期分析","仅基于当前系统内客户、会话和任务数据统计；未接入交易系统前不展示虚构成交或转化率。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("全周期客户", String(metrics.customers.length), "当前系统已建档", "users")}${metric("售前客户", String(metrics.macroStages.get("售前") || 0), "按统一阶段口径", "route")}${metric("售中客户", String(metrics.macroStages.get("售中") || 0), "按统一阶段口径", "chart")}${metric("售后复购窗口", String(metrics.customers.filter((item) => item.microStage === "复购窗口").length), "当前系统已建档", "refresh")}</div><div class="grid detail-grid"><section class="card">${stages.length ? table(["服务环节", "所属阶段", "客户数", "占当前客户", "下钻"], stages.map(([name,macro,count,rate]) => [`<strong>${name}</strong>`,macro,count,progress(rate),`<button class="link" data-action="analytics-drill" data-id="${name}">查看客户</button>`])) : empty("暂无可统计的生命周期记录", "客户进入服务阶段后会在此显示")}</section>${card("当前停滞信号", stalled.length ? `<div class="bar-chart">${stalled.map(([label,value]) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar-fill" style="width:${metrics.customers.length ? value / metrics.customers.length * 100 : 0}%"></div></div><strong>${value}人</strong></div>`).join("")}</div>` : "暂无可识别的停滞信号")}</div>`);
}

function analyticsChannels() {
  const metrics = managementMetrics();
  const channelRows = [...metrics.channels.entries()].sort((a, b) => b[1] - a[1]);
  const projectRows = [...metrics.projects.entries()].sort((a, b) => b[1] - a[1]);
  const topProject = projectRows[0] || ["—", 0];
  return subpage("analytics","channels","渠道与项目分析","仅统计当前系统内已建档客户的来源与项目兴趣；预约、到院和成交待正式业务系统接入后再统计。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("已建档咨询", String(metrics.customers.length), "当前系统内客户", "message")}${metric("来源渠道", String(channelRows.length), "按最近服务渠道归一", "chart")}${metric("项目兴趣TOP1", topProject[0], `${topProject[1]}位客户`, "spark")}${metric("待确认预约", String(metrics.openTasks.filter((item) => /预约/.test(item.title || "")).length), "任务记录口径", "calendar")}</div><div class="grid cols-2"><section class="card">${channelRows.length ? table(["渠道", "客户数", "占当前客户", "下钻"], channelRows.map(([name,count]) => [name,count,progress(metrics.customers.length ? Math.round(count / metrics.customers.length * 100) : 0),`<button class="link" data-action="analytics-drill" data-id="${name}">客户清单</button>`])) : empty("暂无渠道数据", "客户建档后会按来源归一")}</section><section class="card">${projectRows.length ? table(["项目", "兴趣客户", "占当前兴趣", "下钻"], projectRows.map(([name,count]) => [name,count,progress(metrics.customers.length ? Math.round(count / metrics.customers.length * 100) : 0),`<button class="link" data-action="analytics-drill" data-id="${name}">客户清单</button>`])) : empty("暂无项目兴趣数据", "客户表达需求后会进入项目字典")}</section></div>`);
}

function analyticsCollaboration() {
  const metrics = managementMetrics();
  const stages = [["AI辅助会话", metrics.conversations.filter((item) => String(item.mode || "").includes("AI")).length], ["人工接管会话", metrics.humanConversations.length], ["需人工确认任务", metrics.openTasks.filter((item) => ["AI转人工", "AI审批"].includes(item.type)).length]];
  const total = stages.reduce((sum, [, count]) => sum + count, 0);
  const runtime = runtimeAgentMetrics();
  return subpage("analytics","collaboration","人机协作分析","观察AI带来的响应与规模收益，同时监控接管质量、人工负载和医疗边界表现。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("AI参与会话", String(stages[0][1]), "当前本地会话记录", "bot")}${metric("人工接管", String(stages[1][1]), "按会话状态统计", "users")}${metric("待人工确认", String(stages[2][1]), "按任务类型统计", "clock")}${metric("AI员工", String(store.state.agents.length), "当前已配置岗位", "shield")}</div><div class="grid detail-grid"><section class="card">${table(["协作方式", "记录数", "占协作记录", "说明"], stages.map(([name,count]) => [`<strong>${name}</strong>`,count,progress(total ? Math.round(count / total * 100) : 0),"当前系统可追溯记录"]))}</section>${card("按AI员工", `<div class="score-list">${store.state.agents.map((agent) => { const item = runtime.get(agent.id) || { customers:0, conversations:0, openTasks:0 }; return `<div><div class="row between"><button class="link" data-entity="agent" data-id="${agent.id}">${agent.name}</button><strong>${item.customers}位客户</strong></div><div class="caption">关联会话 ${item.conversations} 条 · 未完成待办 ${item.openTasks} 项</div></div>`; }).join("")}</div>`, { subtitle:"客户、会话与任务的当前关系" })}</div>`);
}

function analyticsJourneys() { return journeyReview().replace(moduleSubnav("journeys","review"),moduleSubnav("analytics","journeys")).replace("旅程自动化","经营分析").replace("旅程效果复盘","旅程分析"); }

function physicianSpecialties() {
  const coverage = new Map();
  store.state.physicians.forEach((physician) => physician.specialties.forEach((specialty) => {
    if (!coverage.has(specialty)) coverage.set(specialty, []);
    coverage.get(specialty).push(physician);
  }));
  const fields = [...coverage.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"));
  const activeCount = store.state.physicians.filter((physician) => ["出诊中", "手术日"].includes(physician.status)).length;
  const importedCount = store.state.physicians.filter((physician) => physician.importSource === "华美智能体知识库_v1").length;
  const verifiedCount = store.state.physicians.filter((physician) => physician.status !== "资料待审核").length;
  return subpage("physicians", "specialties", "团队领域概览", "按擅长领域查看团队覆盖、医师梯队与代表项目，便于安排排班和转接客户咨询。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("美形领域", fields.length, "按原始资料分类", "medical")}${metric("可服务医师", activeCount, "仅统计已维护出诊状态", "users")}${metric("知识库导入", importedCount, "待医务与排班核验", "spark")}${metric("已核验资料", verifiedCount, "当前医师档案状态", "shield")}</div>
    <div class="specialty-coverage-grid">${fields.map(([name, physicians]) => `<article class="card specialty-coverage-card"><div class="row between"><div class="specialty-icon">${icon("medical", 18)}</div>${badge(`${physicians.length}位医师`, physicians.length > 1 ? "success" : "outline")}</div><h3>${escapeHtml(name)}</h3><div class="specialty-physicians">${physicians.map((physician) => `<button class="specialty-person" data-entity="physician" data-id="${physician.id}">${physicianAvatar(physician, "sm")}<span><strong>${escapeHtml(physician.name)}</strong><small>${escapeHtml(physician.title)} · ${escapeHtml(physician.department)}</small></span></button>`).join("")}</div><div class="divider"></div><div class="caption">代表项目</div><div class="skill-list">${[...new Set(physicians.flatMap((physician) => physician.signatureProjects))].slice(0, 4).map((project) => badge(project, "outline")).join("")}</div></article>`).join("")}</div>`);
}

function dataQuality() {
  const report = store.state.dataQualityReport || { healthScore:0, status:"待检查", checkedAt:"", summary:{}, issues:[] };
  const summary = report.summary || {};
  const issueCount = (domain, severity = "") => (report.issues || []).filter((item) => item.domain === domain && (!severity || item.severity === severity)).reduce((sum, item) => sum + Number(item.count || 0), 0);
  const fields = [
    ["产品与价格", `${summary.productsWithPrice || 0}/${summary.products || 0} 已维护价格`, "产品档案 + 原始价目证据", issueCount("产品价格"), "价格仅在产品档案维护"],
    ["医师与项目", `${summary.physicians || 0} 位医师`, "医师档案 + 项目字典", issueCount("医师项目", "warning"), "未建唯一关系不自动推荐"],
    ["知识与项目", `${summary.projectDictionaryEntries || 0} 个项目字典项`, "知识库 + 产品目录", issueCount("知识库"), "未匹配项不进入自动推荐"],
    ["客户与会话", `${summary.customerInterestLinks || 0} 条兴趣已关联`, "客户360 + 会话 + 任务", issueCount("客户关联") + issueCount("客户项目"), "异常关联不参与自动执行"],
    ["组织与权限", "角色引用已校验", "用户 + 角色权限", issueCount("组织权限"), "无效角色禁止授权判断"]
  ];
  const healthTone = report.status === "健康" ? "success" : report.status === "需处理" ? "danger" : "warning";
  const issueRows = (report.issues || []).map((item) => [
    `<strong>${escapeHtml(item.domain)}</strong>`, escapeHtml(item.message), String(item.count),
    badge(item.severity === "error" ? "需处理" : item.severity === "warning" ? "待复核" : "待建立", item.severity === "error" ? "danger" : item.severity === "warning" ? "warning" : "outline")
  ]);
  return subpage("analytics","quality","数据质量", "以产品为价格唯一运营主体；原始价目只作为证据资料。客户、会话、任务、知识和权限均按统一主键与状态口径校验，无法确定的关系不自动执行。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("数据健康分", String(report.healthScore ?? 0), `本次检查：${report.status || "待检查"}`, "database", "分")}${metric("待处理问题", String((report.issues || []).filter((item) => item.severity === "error").reduce((sum, item) => sum + item.count, 0)), "阻断自动关联", "alert")}${metric("待人工复核", String((report.issues || []).filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.count, 0)), "保留原始数据不猜测", "users")}${metric("原始价目证据", String(summary.priceEvidenceSources || 0), "可追溯、不可直接报价", "shield")}</div><section class="card" style="margin-bottom:16px"><div class="card-head"><div><div class="card-title">统一数据口径</div><div class="card-subtitle">最近检查 ${report.checkedAt ? formatDate(report.checkedAt) : "尚未执行"}</div></div>${badge(report.status || "待检查", healthTone)}</div>${table(["数据域", "覆盖情况", "权威来源", "待处理", "自动化边界"], fields.map(([name,coverage,source,issues,boundary]) => [`<strong>${name}</strong>`,coverage,source,issues ? badge(`${issues}项`, "warning") : badge("通过", "success"),boundary]))}</section><section class="card"><div class="card-head"><div><div class="card-title">异常与复核清单</div><div class="card-subtitle">仅列出需要处理的数据规则；原始数据已保留，不做不可逆删除。</div></div></div>${issueRows.length ? table(["数据域", "规则说明", "数量", "状态"], issueRows) : empty("当前未发现阻断性数据问题", "所有可自动关联的数据均已通过主键、状态和证据校验。")}</section>`);
}

function integrationMapping() {
  const report = store.state.dataQualityReport || { summary:{}, issues:[] };
  const rows = [["customer_id","客户档案","会话 / 任务","当前系统","主键一致"],["project_dictionary_id","项目字典","客户兴趣 / 知识 / 医师领域","项目字典","唯一匹配才自动关联"],["product_id","产品档案","价格与原始价目证据","产品档案","价格仅维护在产品档案"],["role_id","后台用户","角色 / 权限","组织与权限","无角色即不授权"],["source_reference","原始价目证据","产品价格来源","价目证据资料","缺证据不进入报价审核"]];
  return subpage("integrations","mapping","统一字段映射","一期为独立系统，当前未接入 CRM、收银或外部预约系统。这里展示系统内部已经启用的统一主键和数据来源规则。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("统一主键", "5", "客户、项目、产品、角色、证据", "database")}${metric("项目字典", String(report.summary?.projectDictionaryEntries || 0), "用于客户兴趣与知识关联", "route")}${metric("阻断性冲突", String((report.issues || []).filter((item) => item.severity === "error").reduce((sum, item) => sum + item.count, 0)), "不参与自动执行", "alert")}${metric("外部连接器", "0", "当前阶段未接入", "refresh")}</div><section class="card">${table(["统一字段", "主数据", "关联模块", "权威来源", "处理策略"], rows.map((row) => row))}</section>`);
}

function identityRules() {
  const metrics = managementMetrics();
  return subpage("integrations","identity","统一身份规则","当前阶段仅管理本系统内的客户档案。客户编号是唯一主键；手机号仅脱敏展示，不依据姓名、照片或兴趣自动合并。",
    `<div class="grid cols-3" style="margin-bottom:16px">${metric("客户档案", String(metrics.customers.length), "当前系统内建档", "users")}${metric("重复主键", String((store.state.dataQualityReport?.issues || []).filter((item) => item.code === "duplicate_id" && item.domain === "客户").reduce((sum, item) => sum + item.count, 0)), "发现即阻断自动关联", "refresh")}${metric("待合并候选", "0", "未接入外部身份源，不自动猜测", "alert")}</div><div class="grid cols-2"><section class="card padded"><div class="card-title">当前强标识</div><div class="identity-stack">${[["1","客户编号","系统内唯一主键"],["2","经验证的会话客户引用","仅由服务端生成"],["3","脱敏手机号","仅用于人工核验，不参与自动合并"]].map(([num,name,desc]) => `<div><span>${num}</span><div><strong>${name}</strong><small>${desc}</small></div>${badge("受控使用","success")}</div>`).join("")}</div></section><section class="card padded"><div class="card-title">禁止自动合并的弱信号</div><div class="identity-stack">${[["A","姓名+城市","不能单独合并"],["B","设备ID+时间窗口","当前未接入"],["C","照片相似","禁止用于身份自动合并"],["D","项目兴趣+来源","只能辅助人工判断"]].map(([num,name,desc]) => `<div><span>${num}</span><div><strong>${name}</strong><small>${desc}</small></div>${badge("人工复核","warning")}</div>`).join("")}</div></section></div><div class="risk-banner" style="margin-top:16px">${icon("shield",16)}医疗记录、支付记录、投诉记录不能仅凭姓名或照片自动合并；每次合并、拆分和查看均写入审计。</div>`);
}

function organizationPage() {
  const groups = [...new Set((store.state.managementUsers || []).map((item) => item.department).filter(Boolean))].map((department) => {
    const users = store.state.managementUsers.filter((item) => item.department === department);
    return [department, users[0]?.name || "待分配", `${users.length}人`, "按角色权限分配", "本地系统维护"];
  });
  return subpage("integrations","organization","组织与人员","组织决定数据范围，角色决定功能权限，班次与技能决定任务和人工接管的路由。",
    `<div class="org-tree"><div class="org-root"><span class="brand-mark">美</span><div><strong>上海华美医疗美容医院</strong><small>一期本地独立运行</small></div>${badge("本地运营","success")}</div><div class="org-branches">${groups.map(([name,owner,count,agents,hours]) => `<article><div class="row between"><strong>${name}</strong>${badge(count,"outline")}</div><p>负责人：${owner}</p><p>协作AI：${agents}</p><div class="divider"></div><span class="caption">服务范围 ${hours}</span></article>`).join("") || empty("尚未维护组织人员", "新增后台用户后会按所属科室显示")}</div></div>`);
}

function lifecycleSettings() {
  const dictionary = store.state.projectDictionary || [];
  return subpage("integrations","lifecycle","阶段与项目字典","一期统一维护客户阶段、服务环节和项目别名。项目字典来自产品档案与知识库，只有唯一匹配的关联才能进入自动流程。",
    `<div class="grid cols-3">${Object.entries(stageSteps).map(([stage,steps]) => `<section class="card padded"><div class="row between"><strong>${stage}</strong>${badge(`${steps.length}个环节`,stage)}</div><div class="step-list">${steps.map((step,index) => `<div><span>${index+1}</span><strong>${step}</strong><button class="link" data-action="stage-config">配置</button></div>`).join("")}</div></section>`).join("")}</div><section class="card padded" style="margin-top:16px"><div class="row between"><div><div class="card-title">项目字典与别名</div><div class="card-subtitle">当前共 ${dictionary.length} 个字典项，来自产品目录与知识库的可追溯归一</div></div><button class="btn small primary" data-action="project-new">新增项目</button></div><div class="project-dictionary">${dictionary.slice(0, 12).map((item) => `<div><strong>${escapeHtml(item.canonicalName)}</strong><span>${escapeHtml((item.aliases || []).slice(0, 3).join(" / ") || "—")}</span>${badge(item.productIds?.length ? "已关联产品" : "仅知识条目",item.productIds?.length ? "success" : "outline")}<small>产品 ${item.productIds?.length || 0} · 知识 ${item.knowledgeIds?.length || 0}</small></div>`).join("") || empty("暂无项目字典", "导入产品或知识后会自动建立可复核的字典项")}</div></section>`);
}

function permissionsPage() {
  const roles = store.state.managementRoles || [];
  const users = store.state.managementUsers || [];
  const audits = store.state.audit || [];
  return subpage("integrations","permissions","权限与审计","一期采用五岗位职责分离。角色权限只读展示，所有越权尝试均应进入审计记录。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("固定角色", String(roles.length), "一期不开放新增第三角色", "users")}${metric("已分配用户", String(users.filter((item) => item.roleId).length), "角色引用已校验", "shield")}${metric("审计事件", String(audits.length), "当前系统审计记录", "database")}${metric("越权拦截", "待接入", "需由权限引擎日志回填", "alert")}</div><section class="card">${table(["固定角色", "数据范围", "已配置权限", "已分配用户", "状态", "说明"], roles.map((role) => [`<strong>${escapeHtml(role.name)}</strong>`,escapeHtml(role.scope || "待维护"),(role.permissions || []).map((item) => badge(item,"outline")).join(" ") || "—",users.filter((user) => user.roleId === role.id).length,badge(role.status || "待维护",role.status === "启用" ? "success" : "warning"),"一期只读；角色扩展需版本评审"]))}</section>`);
}

function administrationUsers() {
  const users = store.state.managementUsers || [];
  return subpage("administration", "overview", "用户管理", "维护后台登录用户、所属科室与一期固定角色。用户启停与角色变更均保留操作审计；正式生产环境将由企业 SSO 接管身份认证。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("后台用户", String(users.length), "本地系统已登记", "users")}${metric("已启用", String(users.filter((item) => item.status === "启用").length), "可正常登录", "check")}${metric("固定角色", String((store.state.managementRoles || []).length), "五岗位职责分离", "shield")}${metric("未分配角色", String(users.filter((item) => !item.roleId).length), "需分配固定角色", "clock")}</div><section class="card">${users.length ? table(["姓名 / 售前昵称", "登录账号 / 售前 ID", "所属科室", "角色", "状态", "最近更新", "操作"], users.map((item) => ["<strong>" + escapeHtml(item.name) + "</strong><div class=\"caption\">" + escapeHtml(item.nickname || "未设置昵称") + "</div>", escapeHtml(item.account) + `<div class="caption">${escapeHtml(item.staffId || "未设置售前 ID")}</div>`, escapeHtml(item.department), badge(item.role || "未分配", "outline"), badge(item.status, item.status === "启用" ? "success" : "warning"), relativeTime(item.updatedAt), `<button class="link" data-action="edit-management-user" data-id="${escapeHtml(item.id)}">编辑</button><button class="link" data-action="toggle-management-user" data-id="${escapeHtml(item.id)}">${item.status === "启用" ? "停用" : "启用"}</button>`])) : empty("暂无后台用户", "请新增需要登录管理后台的用户，并分配管理员或售前人员角色。")}</section>`, `<button class="btn primary" data-action="new-management-user">${icon("plus",15)}新增用户</button>`);
}

function administrationRoles() {
  const roles = store.state.managementRoles || [];
  return subpage("administration", "roles", "角色管理", "一期角色说明（只读）：采用系统管理员、售前顾问、内容专员、发布与索引管理员、质量与运营人员五岗位。管理员维护平台与医院数据；售前人员仅处理客户会话和已授权话术。",
    `<section class="card">${roles.length ? table(["固定角色", "数据范围", "一期职责", "状态", "变更方式"], roles.map((item) => ["<strong>" + escapeHtml(item.name) + "</strong>", escapeHtml(item.scope), (item.permissions || []).map((permission) => badge(permission,"outline")).join(" ") || "—", badge(item.status, item.status === "启用" ? "success" : "warning"), "本期只读，不支持新增、编辑或删除"])) : empty("固定角色加载失败", "请重新连接管理数据服务；一期不允许手工创建角色。")}</section><div class="guardrail" style="margin-top:16px">${icon("shield",14)}角色扩展、跨科室数据授权或新增高风险操作，需在后续版本完成权限设计与安全评审后再开放。</div>`);
}

function administrationPermissions() {
  const roles = store.state.managementRoles || [];
  const roleNames = (matcher) => roles.filter((item) => (item.permissions || []).some((permission) => matcher.test(permission))).map((item) => item.name).join("、") || "—";
  return subpage("administration", "permissions", "权限管理", "一期权限随固定角色生效，仅用于查看。此页面不显示客户联系方式、病历或完整会话原文，也不提供角色或权限编辑入口。",
    `<section class="card">${table(["权限域", "允许角色", "额外约束"], [["平台与智能体", roleNames(/平台|智能体|用户|审计/), "仅管理员维护；角色本身不可在本期改写"],["医院数据", roleNames(/医院|医生|项目|价格|知识/), "仅管理员维护；价格和知识仍按对客使用规则校验"],["客户中心与会话", roleNames(/客户|会话|预约|机器人/), "售前人员仅处理已分配会话，敏感字段按授权最小化展示"],["常用话术", roleNames(/话术/), "管理员维护；售前人员仅查看和在内部会话窗口插入"]].map((row) => ["<strong>" + row[0] + "</strong>", row[1], row[2]]))}</section>`);
}

function administrationAudit() {
  const events = (store.state.audit || []).slice(0, 30);
  return subpage("administration", "audit", "操作审计", "记录用户、角色、产品和价格等后台维护操作。本地演示数据不含真实客户个人信息。",
    `<section class="card">${table(["时间", "操作人", "操作", "对象", "结果", "风险"], events.map((item) => [formatDate(item.at), escapeHtml(item.actor), escapeHtml(item.action), escapeHtml(item.object), escapeHtml(item.result), badge(item.severity, item.severity === "高" ? "danger" : item.severity === "中" ? "warning" : "success")]))}</section>`);
}

function catalogProducts() {
  const products = store.state.products || [];
  const onSale = products.filter((item) => item.salesStatus === "在售").length;
  const pending = products.filter((item) => item.approvalStatus !== "已通过").length;
  const priced = products.filter((item) => item.price).length;
  const productTone = (item) => item.salesStatus === "在售" ? "success" : item.salesStatus === "停售" ? "danger" : "warning";
  return subpage("catalog", "overview", "产品管理", "价格作为产品档案字段统一维护。系统已从原始价目资料中提取可直接匹配的参考价格；运营人员可在编辑产品时继续核验和维护。",
    `<div class="grid cols-4" style="margin-bottom:16px">${metric("产品项目", String(products.length), "可继续维护与扩充", "database")}${metric("当前在售", String(onSale), "按销售状态统计", "chart")}${metric("待审核", String(pending), "不用于对客回答", "shield")}${metric("已匹配参考价格", String(priced), "来自内部价目资料", "clock")}</div><section class="card">${table(["产品", "科室 / 分类", "资料参考价", "销售状态", "审核状态", "负责人", "更新时间", "操作"], products.map((item) => ["<strong>" + escapeHtml(item.name) + "</strong><br/><small>编码：" + escapeHtml(item.productCode || "待编") + " · " + escapeHtml(item.serviceType || "医美项目") + "</small>", escapeHtml(`${item.department || "待维护"} / ${item.category || "待维护"}`), badge(item.priceType || "未录入价格", "outline") + `<br/><strong>${escapeHtml(item.price || "—")}</strong>`, badge(item.salesStatus || "待维护", productTone(item)), badge(item.approvalStatus || "待审核", item.approvalStatus === "已通过" ? "success" : "warning"), escapeHtml(item.owner || "待分配"), relativeTime(item.updatedAt), `<button class="link" data-action="edit-product" data-id="${escapeHtml(item.id)}">编辑产品</button>`]))}</section><div class="guardrail" style="margin-top:16px">${icon("shield",14)}资料参考价来自内部价目素材，尚不等同于当前对客报价。运营人员核验后可直接在产品档案中维护正式价格及有效期。</div>`, `<button class="btn primary" data-action="new-product">${icon("plus",15)}新增产品</button>`);
}

function demoSettings() {
  return subpage("integrations","demo","数据服务说明","业务记录由服务端本地持久化服务保存；为保护已录入的运营资料，系统不提供“恢复样例数据”或清空数据的前端入口。",
    `<div class="grid cols-3"><section class="card padded demo-card"><div class="demo-icon success">${icon("database",22)}</div><h3>数据范围</h3><p>客户、会话、任务、旅程、组织权限和对接预留均以服务端记录为准。</p>${badge("服务端保存","success")}</section><section class="card padded demo-card"><div class="demo-icon warning">${icon("shield",22)}</div><h3>删除保护</h3><p>清理或导出数据需经过管理员审批并在受控环境执行，前台不会执行不可恢复的批量操作。</p>${badge("受控","warning")}</section><section class="card padded demo-card"><div class="demo-icon">${icon("refresh",22)}</div><h3>外部系统</h3><p>CRM、预约、收银和企业微信均未接入；登记对接预留不等于已建立数据连接。</p>${badge("未接入","outline")}</section></div>`);
}

const subpageRenderers = {
  workbench: { team: teamWorkbench, approvals: approvalQueue, takeovers: takeoverQueue },
  customers: { lifecycle: lifecycleBoard, segments: segmentList, ownership: ownershipPage, duplicates: duplicatesPage },
  conversations: { takeovers: conversationTakeovers, quality: conversationQuality, "bad-cases": conversationBadCases, templates: conversationTemplates },
  journeys: { templates: journeyTemplatePage, instances: journeyInstances, review: journeyReview },
  agents: { logs: agentLogs, evaluations: () => evaluationsPage("agents","evaluations"), versions: agentVersions, api: agentApiPlatform },
  physicians: { specialties: physicianSpecialties },
  knowledge: { rules: knowledgeRules, audit: knowledgeAudit, evaluations: () => evaluationsPage("knowledge","evaluations") },
  catalog: { overview: catalogProducts },
  analytics: { lifecycle: analyticsLifecycle, channels: analyticsChannels, collaboration: analyticsCollaboration, journeys: analyticsJourneys, quality: dataQuality },
  integrations: { mapping: integrationMapping, identity: identityRules, organization: organizationPage, lifecycle: lifecycleSettings, permissions: permissionsPage, demo: demoSettings },
  administration: { overview: administrationUsers, roles: administrationRoles, permissions: administrationPermissions, audit: administrationAudit }
};

export const renderSubpage = (route, key, context = {}) => subpageRenderers[route]?.[key]?.(context) || "";

function notFound(kind, id, back) {
  return `<div class="page">${pageHead("记录未找到", `${kind}不存在`, `这条记录可能已被删除或重置。`, `<a class="btn primary" href="#/${back}">返回列表</a>`)}${empty("记录不可用", "请从对应模块重新选择")}</div>`;
}

function taskDetail(id) {
  const task = store.task(id);
  if (!task) return notFound("任务",id,"workbench");
  const customer = store.customer(task.customerId);
  const related = customer.timeline.filter((event) => ["task","conversation","profile","stage","risk"].includes(event.type)).slice(0,5);
  return `<div class="page">${pageHead("任务详情", task.title, `${customer.macroStage}/${customer.microStage} · 来源：${task.source}`, `<a class="btn" href="#/workbench">返回工作台</a>${task.status!=="已完成"?`<button class="btn primary" data-action="complete-task" data-id="${task.id}">${icon("check",15)}完成任务</button>`:""}`)}<section class="detail-hero"><div class="object-icon">${icon(task.type==="AI转人工"?"alert":"check",22)}</div><div><div class="row wrap">${badge(task.status,task.status==="已完成"?"success":"warning")}${badge(task.priority,task.priority==="紧急"?"danger":"outline")}${badge(task.type,"ai")}</div><h2>${task.title}</h2><p>${task.reason} · 截止 ${formatDate(task.dueAt)}</p></div><div class="object-actions"><button class="btn" data-action="reassign" data-id="${customer.id}">转派责任人</button><button class="btn" data-customer="${customer.id}">客户360</button></div></section><div class="grid entity-layout"><div class="stack">${card("任务目标与成功信号", `<div class="profile-list"><div class="profile-row"><span class="profile-key">经营卡点</span><strong>${task.reason}</strong></div><div class="profile-row"><span class="profile-key">成功信号</span><span>${task.type==="AI转人工"?"人工明确承接并给出合规回复":"客户状态或下一动作得到确认"}</span></div><div class="profile-row"><span class="profile-key">执行责任人</span><span>${task.assignee}</span></div><div class="profile-row"><span class="profile-key">动作来源</span><span>${task.source}</span></div></div>`)}${card("相关事项时间线", related.map((event) => `<div class="evidence-event"><span class="timeline-dot ${event.tone||""}"></span><div><strong>${event.title}</strong><p>${event.detail}</p><small>${formatDate(event.occurredAt)} · ${event.actor}</small></div></div>`).join("")||empty("暂无事件","任务完成后会写入时间线"))}</div><aside class="stack">${card("关联客户", `<div class="row">${avatar(customer,"lg")}<div><button class="link object-name" data-customer="${customer.id}">${customer.name}</button><p class="caption">${customer.macroStage}/${customer.microStage}<br/>${customer.owner} · ${customer.agent}</p></div></div><div class="divider"></div><div class="profile-list"><div class="profile-row"><span class="profile-key">感兴趣项目</span><strong>${customer.interests[0]?.name||"待识别"}</strong></div><div class="profile-row"><span class="profile-key">痛点</span><span>${customer.pains.join("、")}</span></div><div class="profile-row"><span class="profile-key">下一策略</span><span>${customer.nextAction.title}</span></div></div>`)}${card("责任与记录", `<div class="responsibility-row"><span class="responsibility-icon">${icon("users",15)}</span><div><strong>${customer.owner}</strong><div class="caption">人工主责</div></div></div><div class="responsibility-row"><span class="responsibility-icon">${icon("bot",15)}</span><div><strong>${customer.agent}</strong><div class="caption">协作AI</div></div></div><div class="guardrail">${icon("shield",14)}任务变更与完成结果将同步到客户360时间线。</div>`)}</aside></div></div>`;
}

function conversationDetail(id) {
  const conversation = store.conversation(id);
  if (!conversation) return notFound("会话",id,"conversations");
  const customer = store.customer(conversation.customerId);
  const auditRecords = (store.state.audit || []).filter((item) => String(item.object || "") === conversation.id || String(item.object || "").includes(conversation.id));
  const latestAudit = auditRecords[0];
  const messages = (conversation.messages || []).map((message) => {
    const speaker = message.from === "customer" ? customer.name : message.from === "system" ? "合规守门员" : message.from === "ai" ? customer.agent || "AI辅助" : customer.owner || "人工顾问";
    const evidence = message.evidence || message.reference || "";
    return `<article class="transcript-message ${message.from}"><div class="row between"><strong>${escapeHtml(speaker)}</strong><small>${formatDate(message.at)}</small></div><p>${escapeHtml(message.text)}</p>${evidence ? `<div class="message-evidence">${icon("database",13)}${escapeHtml(evidence)}</div>` : ""}${message.from === "system" ? `<div class="message-evidence danger">${icon("shield",13)}AI在此停止自动回答</div>` : ""}</article>`;
  }).join("") || empty("暂无会话内容", "创建会话草稿后，首条消息需由人工单独编辑和发送。");
  const auditAction = latestAudit ? `<button class="btn small" data-action="view-audit" data-id="${escapeHtml(latestAudit.id)}">查看处理记录</button>` : `<div class="caption">暂无与该会话关联的审计记录</div>`;
  return `<div class="page">${pageHead("会话详情", `${customer.name} · ${conversation.channel}会话`, `${conversation.status} · 更新于 ${relativeTime(conversation.updatedAt)}`, `<a class="btn" href="#/conversations">返回收件箱</a><button class="btn primary" data-action="handover-conversation" data-id="${conversation.id}">${icon("users",15)}人工接管</button>`)}<div class="grid conversation-detail-layout"><section class="card conversation-transcript"><header><div class="row">${avatar(customer,"sm")}<div><strong>${customer.name}</strong><small>${customer.macroStage}/${customer.microStage} · ${conversation.channel}</small></div></div><div>${badge(conversation.mode,"ai")} ${badge(conversation.status)}</div></header><div class="transcript-body">${messages}</div></section><aside class="stack">${card("质检与处理依据", `<div class="profile-list"><div class="profile-row"><span class="profile-key">当前质检状态</span>${badge(conversation.qualityStatus || "尚未质检", conversation.qualityStatus ? "warning" : "outline")}</div><div class="profile-row"><span class="profile-key">关联审计记录</span><span>${auditRecords.length} 条</span></div><div class="profile-row"><span class="profile-key">人工接管状态</span>${badge(["待人工","人工处理中"].includes(conversation.status) ? "需要人工处理" : "按当前会话状态", ["待人工","人工处理中"].includes(conversation.status) ? "warning" : "outline")}</div></div>${auditAction}`)}${card("客户360摘要", `<div class="row">${avatar(customer,"sm")}<button class="link object-name" data-customer="${customer.id}">${customer.name}</button></div><div class="divider"></div><p class="caption">兴趣：${customer.interests.map((item)=>`${item.name} ${item.score}`).join(" · ") || "待识别"}</p><p class="caption">痛点：${customer.pains.join("、") || "待补充"}</p><p class="caption">下一策略：${customer.nextAction?.title || "待制定"}</p>`)}${card("责任链", `<div class="responsibility-row"><span class="responsibility-icon">${icon("users",15)}</span><div><strong>${escapeHtml(customer.owner || "待分配")}</strong><small>人工主责</small></div></div><div class="responsibility-row"><span class="responsibility-icon">${icon("bot",15)}</span><div><strong>${escapeHtml(customer.agent || "未配置")}</strong><small>协作AI</small></div></div>`)}</aside></div></div>`;
}

function journeyDetail(id) {
  const journey = store.state.journeys.find((item) => item.id === id);
  if (!journey) return notFound("旅程",id,"journeys");
  return `<div class="page">${pageHead("旅程编排", journey.name, `当前版本 ${journey.version} · ${journey.stage} · 修改后保存为新版本，正在服务客户的版本不会被覆盖。`, `<a class="btn" href="#/journeys">返回列表</a><button class="btn" data-action="test-journey">测试运行</button><button class="btn primary" data-action="save-journey">保存新版本</button>`)}<div class="object-tabs"><button class="active">流程编排</button><a href="#/journeys/instances">客户旅程进度</a><a href="#/journeys/review">效果复盘</a><button data-action="version-detail">版本记录</button></div><section class="card grid journey-editor"><aside class="node-palette"><div class="card-title">流程步骤</div><div class="card-subtitle">加入流程后设置执行条件</div><div class="stack" style="margin-top:14px">${[["开始条件","新咨询、预约、支付"],["判断条件","阶段、兴趣、授权、行为"],["AI服务动作","解释、提醒、问卷"],["人工任务","邀约、接管、回访"],["等待安排","固定时间或等待客户动作"],["合规检查","授权、联系频次、医疗边界"]].map(([title,desc]) => `<button class="btn node-tool" data-action="add-node"><span class="responsibility-icon">${icon("plus",13)}</span><span><strong>${title}</strong><small>${desc}</small></span></button>`).join("")}</div></aside><div class="canvas">${journey.nodes.map((node,index) => `<div class="flow-node ${index===2?"active":""}"><div class="row"><span class="responsibility-icon">${icon(index===0?"spark":index===journey.nodes.length-1?"check":"route",14)}</span><div><div class="flow-node-title">${node}</div><div class="flow-node-type">步骤 ${index+1} · ${index===0?"开始条件":index===journey.nodes.length-1?"目标/退出":"需校验的自动动作"}</div></div></div>${index<journey.nodes.length-1?`<span class="flow-connector">${icon("chevron",14)}</span>`:""}</div>`).join("")}</div><aside class="properties"><div class="row between"><div><div class="card-title">步骤设置</div><div class="card-subtitle">${journey.nodes[2]||journey.nodes[0]}</div></div>${badge("需校验的自动动作","ai")}</div><div class="property-block"><label>执行条件</label><p>客户阶段与兴趣规则匹配，授权仍有效，且未超过联系频次限制。</p></div><div class="property-block"><label>成功路径</label><p>记录到客户360时间线，并推进至下一环节。</p></div><div class="property-block"><label>超时路径</label><p>24小时未完成则创建人工任务。</p></div><div class="risk-banner">${icon("shield",14)}执行前重新检查授权、联系频次与医疗边界。</div></aside></section></div>`;
}

function agentDetail(id) {
  const agent = store.state.agents.find((item) => item.id === id);
  if (!agent) return notFound("AI员工",id,"agents");
  const recent = store.state.tasks.filter((task)=>task.assignee.includes(agent.name.split("·")[0])||task.assignee===agent.name).slice(0,5);
  const runtime = runtimeAgentMetrics().get(agent.id) || { customers:0, conversations:0, openTasks:0 };
  return `<div class="page">${pageHead("AI员工详情", agent.name, `${agent.role} · ${agent.level}`, `<a class="btn" href="#/agents">返回列表</a><a class="btn" href="#/agents/evaluations">查看评测状态</a><button class="btn ${agent.status==="已停用"?"success":"danger"}" data-action="toggle-agent" data-id="${agent.id}" ${agent.id==="A-06"?"disabled":""}>${agent.status==="已停用"?"启用":"停用"}</button>`)}<section class="detail-hero agent-hero"><div class="object-icon">${icon(agent.id==="A-06"?"shield":"bot",24)}</div><div><div class="row">${badge(agent.status,agent.status==="运行中"?"success":"warning")}${badge(agent.level,"brand")}${badge("评测结果待流水线回填","outline")}</div><h2>${agent.name}</h2><p>${agent.role}。AI负责理解客户表达并生成回复，安全规则负责检查授权、医疗边界和合规要求；人工负责人始终保留最终责任。</p></div><div class="agent-hero-kpis"><div><strong>${runtime.customers}</strong><span>当前服务客户</span></div><div><strong>${runtime.conversations}</strong><span>关联会话</span></div><div><strong>${runtime.openTasks}</strong><span>未完成待办</span></div></div></section><div class="object-tabs"><button class="active">岗位设置</button><a href="#/agents/logs">执行记录</a><a href="#/agents/evaluations">测试结果</a><a href="#/agents/versions">版本管理</a></div><div class="grid entity-layout"><div class="stack"><div class="grid cols-2">${card("允许能力", `<div class="skill-list">${agent.skills.map((item)=>badge(item,"success")).join("")}</div><div class="divider"></div><p class="caption">仅在当前客户阶段、授权和知识范围内执行。</p>`)}${card("禁止动作", `<div class="skill-list">${agent.forbidden.map((item)=>badge(item,"danger")).join("")}</div><div class="divider"></div><p class="caption">任何业务角色都不能绕过医疗安全与隐私保护规则。</p>`)}</div>${card("最近执行记录", recent.length?table(["任务","客户","来源","状态","详情"],recent.map((task)=>[task.title,store.customer(task.customerId)?.name||"—",task.source,badge(task.status),actionLink("任务详情","task",task.id)])):empty("暂无直接任务","执行记录仍可在回答追溯中查看"))}</div><aside class="stack">${card("当前设置", `<div class="profile-list"><div class="profile-row"><span class="profile-key">可用知识</span><strong>${agent.knowledge.replace(/\s+v[\d.]+$/i, "")}</strong></div><div class="profile-row"><span class="profile-key">工作状态</span><strong id="llm-runtime-value">检测中</strong></div><div class="profile-row"><span class="profile-key">人工责任人</span><span>${agent.id==="A-06"?"合规负责人":"对应业务团队负责人"}</span></div><div class="profile-row"><span class="profile-key">使用范围</span>${badge(agent.status==="试运行"?"小范围试用":"已启用","success")}</div></div>`)}${card("工作边界", `<div class="guardrail">${icon("shield",14)}AI只接收完成当前任务所需的信息；可查找已通过审核的知识，不可诊断、判断个体适用性或承诺效果。</div><a class="btn small" style="margin-top:12px" href="#/agents/logs">查看工作记录</a>`)}</aside></div></div>`;
}

function physicianDetail(id) {
  const physician = store.physician(id);
  if (!physician) return notFound("医师", id, "physicians");
  const satisfaction = physician.satisfaction ? `${physician.satisfaction}%` : "待积累";
  const imported = physician.importSource === "华美智能体知识库_v1";
  return `<div class="page"><a class="detail-back" href="#/physicians">${icon("chevron",14)}<span>返回医师团队</span></a>${pageHead("医师档案", physician.name, `${physician.department} · 更新于 ${relativeTime(physician.updatedAt)}`, `${imported ? "" : `<button class="btn soft" data-action="physician-avatar" data-id="${physician.id}">${icon("spark",15)}创建AI分身视频</button>`}<button class="btn" data-action="edit-physician" data-id="${physician.id}">${icon("edit",15)}编辑资料</button><button class="btn danger" data-action="delete-physician" data-id="${physician.id}">删除医师</button>`)}
    <section class="detail-hero physician-detail-hero">${physicianAvatar(physician, "xl")}<div><div class="row wrap">${badge(physician.status, ["出诊中","手术日"].includes(physician.status)?"success":physician.status==="进修中"?"warning":"outline")}${badge(physician.title,"brand")}${badge(physician.department,"outline")}${imported ? badge("知识库导入","brand") : ""}</div><h2>${escapeHtml(physician.name)}</h2><p>${escapeHtml(physician.branch)} · ${escapeHtml(physician.education)} · ${physician.years ? `从业 ${physician.years} 年` : "从业年限待核验"}</p></div><div class="agent-hero-kpis"><div><strong>${physician.years || "—"}</strong><span>从业年限</span></div><div><strong>${physician.specialties.length}</strong><span>擅长领域</span></div><div><strong>${imported ? `${physician.sourceRecordCount || 0}份` : physician.consultationCount || 0}</strong><span>${imported ? "原始资料" : "咨询量"}</span></div></div></section>
    <div class="grid entity-layout"><div class="stack">
      <div class="grid cols-2">${card("基本信息", `<div class="profile-list"><div class="profile-row"><span class="profile-key">姓名 / 性别</span><strong>${escapeHtml(physician.name)} · ${escapeHtml(physician.gender)}</strong></div><div class="profile-row"><span class="profile-key">职称</span><span>${escapeHtml(physician.title)}</span></div><div class="profile-row"><span class="profile-key">科室</span><span>${escapeHtml(physician.department)}</span></div><div class="profile-row"><span class="profile-key">所属院区</span><span>${escapeHtml(physician.branch)}</span></div><div class="profile-row"><span class="profile-key">团队角色</span><span>${escapeHtml(physician.hospitalTenure || "—")}</span></div><div class="profile-row"><span class="profile-key">联系号码</span><span>${escapeHtml(physician.mobile || "—")}</span></div></div>`)}${card("执业与教育", `<div class="profile-list"><div class="profile-row"><span class="profile-key">教育背景</span><strong>${escapeHtml(physician.education || "—")}</strong></div><div class="profile-row"><span class="profile-key">执业证书编号</span><span>${escapeHtml(physician.registrationNo || "—")}</span></div><div class="profile-row"><span class="profile-key">执业范围</span><span>${escapeHtml(physician.registrationScope || "—")}</span></div><div class="profile-row"><span class="profile-key">出诊状态</span>${badge(physician.status)}</div><div class="profile-row"><span class="profile-key">排班安排</span><span>${escapeHtml(physician.schedule || "待排班")}</span></div><div class="profile-row"><span class="profile-key">满意度</span><strong>${satisfaction}</strong></div></div>`)}</div>
      ${card("擅长美形领域", `<div class="physician-expertise-list">${physician.specialties.map((specialty,index) => `<div><span>${String(index+1).padStart(2,"0")}</span><div><strong>${escapeHtml(specialty)}</strong><small>便于咨询转接与医师筛选</small></div></div>`).join("")}</div>`, { subtitle: "已分类维护" })}
      ${card("医师简介", `<div class="knowledge-content"><p>${escapeHtml(physician.bio || "暂未维护医师简介。")}</p></div>`, { subtitle: imported ? "知识库原始资料摘要，待资质与合规审核" : "仅用于团队档案与一般信息展示" })}
    </div><aside class="stack">
      ${card("代表项目", `<div class="skill-list">${physician.signatureProjects.map((project) => badge(project,"brand")).join("") || badge("待维护","outline")}</div><div class="guardrail">${icon("shield",14)}代表项目仅表达团队分工，不构成针对客户的适用性判断或医疗建议。</div>`)}
      ${card("排班与服务", `<div class="profile-list"><div class="profile-row"><span class="profile-key">当前状态</span>${badge(physician.status)}</div><div class="profile-row"><span class="profile-key">常规排班</span><strong>${escapeHtml(physician.schedule || "待排班")}</strong></div><div class="profile-row"><span class="profile-key">院区</span><span>${escapeHtml(physician.branch)}</span></div><div class="profile-row"><span class="profile-key">咨询量</span><span>${imported ? "待业务系统接入" : physician.consultationCount || "待维护"}</span></div></div>`)}
      ${card("档案状态", `<div class="profile-list"><div class="profile-row"><span class="profile-key">医师档案编号</span><strong>${physician.id}</strong></div><div class="profile-row"><span class="profile-key">最近更新</span><span>${formatDate(physician.updatedAt)}</span></div><div class="profile-row"><span class="profile-key">资料状态</span>${badge(imported ? "待资质与合规审核" : "已完善",imported ? "warning" : "success")}</div>${imported ? `<div class="profile-row"><span class="profile-key">来源目录</span><span>${escapeHtml(physician.sourceCollectionPath || "医生介绍")}</span></div>` : ""}</div><div class="guardrail">${icon("shield",14)}${imported ? "导入资料不会自动成为医生推荐、排班或预约依据；请先完成资质、院区、排班与擅长范围核验。" : "所有资料变更都会保留责任人和时间记录，便于追溯。"}</div>`)}
    </aside></div>
  </div>`;
}

const knowledgeParagraph = (value) => escapeHtml(String(value || "—")).replace(/\n/g,"<br>");
const knowledgeBackLink = `<a class="detail-back" href="#/knowledge">${icon("chevron",14)}<span>返回知识库</span></a>`;

function projectKnowledgeDetail(item) {
  const asList = (value) => Array.isArray(value) ? value : value ? [value] : [];
  const sectionContent = (item.sections || []).map((section) => `<section class="knowledge-section"><h3>${escapeHtml(section.title)}</h3><p>${knowledgeParagraph(section.content)}</p></section>`).join("");
  const effects = (item.efficacyLabels || []).map((effect) => badge(effect,"outline")).join("") || badge("待整理","warning");
  const parts = (item.parts || []).map((part) => badge(part,"brand")).join("") || badge("未标注部位","outline");
  const answerScope = asList(item.aiScope).map((scope) => `<li>${escapeHtml(scope)}</li>`).join("") || "<li>一般项目介绍、原理、功效与就诊流程</li>";
  const handoff = asList(item.handoff).map((scope) => `<li>${escapeHtml(scope)}</li>`).join("") || "<li>个体适用性、治疗方案与异常情况</li>";
  const promotionalTerms = asList(item.promotionalTerms);
  const promotional = promotionalTerms.length
    ? `<div class="risk-banner">${icon("alert",14)}<div><strong>需重点复核的原始表达</strong><div class="knowledge-tags">${promotionalTerms.map((term) => badge(term,"danger")).join("")}</div></div></div>`
    : `<div class="guardrail">${icon("shield",14)}当前资料未发现需特别复核的宣传表达，正式启用前仍须完成全文审核。</div>`;
  const sourceLink = item.sourceUrl ? `<a class="btn small" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">查看原始页面</a>` : "";
  return `<div class="page">${knowledgeBackLink}${pageHead("项目知识", item.cardTitle || item.title, `${item.project} · 来源：${item.sourceTitle || "百度项目资料"} · 采集于 ${formatDate(item.updatedAt)}`, `${item.status.includes("审核")?`<button class="btn primary" data-action="approve-knowledge" data-id="${item.id}">进入双审</button>`:item.status==="已发布"?`<button class="btn danger" data-action="unpublish-knowledge" data-id="${item.id}">下架</button>`:""}`)}
    <section class="detail-hero"><div class="object-icon">${icon("database",23)}</div><div><div class="row">${badge(item.status,item.status==="已发布"?"success":"warning")}${badge(knowledgeStageLabel(item.layer),"brand")}${badge(riskLabel(item.risk,item.riskLabel),item.risk==="H3"?"danger":item.risk==="H2"?"warning":"outline")}</div><h2>${escapeHtml(item.cardTitle || item.title)}</h2><p>${escapeHtml(item.sourceTitle || item.project)} · ${(item.parts || []).join("/") || "适用部位待复核"}</p></div><div class="object-actions"><a class="btn" href="#/knowledge/evaluations">查看评测状态</a>${sourceLink}</div></section>
    <div class="risk-banner knowledge-source-notice">${icon("alert",15)}<div><strong>原始采集内容，仅供内部审核与来源追溯</strong><br/>介绍、功效和效果描述已完整保留；未经医务与合规双审前，不直接用于正式对客回答。</div></div>
    <div class="object-tabs"><button class="active">知识正文</button><span class="caption">来源与溯源见本页</span><a href="#/knowledge/audit">使用记录</a></div>
    <div class="grid entity-layout"><div class="stack">
      <div class="grid cols-2">${card("项目介绍", `<div class="knowledge-content"><p>${knowledgeParagraph(item.introduction)}</p></div>`, { subtitle: "一般原理与项目说明" })}${card("功效与改善方向", `<div class="knowledge-content"><p>${knowledgeParagraph(item.efficacy)}</p><div class="knowledge-tags">${effects}</div></div>`, { subtitle: "原始功效描述，待审核" })}</div>
      ${card("完整项目知识", `<div class="knowledge-content knowledge-sections">${sectionContent}</div>`, { subtitle: `${(item.sections || []).length}个内容章节，内容已按原资料完整整理` })}
      ${card("咨询讲解范围与转人工边界", `<div class="grid cols-2 knowledge-boundary"><div><h3>可进行的一般讲解</h3><ul>${answerScope}</ul></div><div><h3>必须转人工/医生</h3><ul>${handoff}</ul></div></div>${promotional}`)}
    </div><aside class="stack">
      ${card("项目标签", `<div class="caption">适用部位</div><div class="knowledge-tags">${parts}</div><div class="caption knowledge-label-gap">功效标签</div><div class="knowledge-tags">${effects}</div>`)}
      ${card("来源页面信息", `<div class="profile-list"><div class="profile-row"><span class="profile-key">标准项目</span><strong>${escapeHtml(item.project)}</strong></div><div class="profile-row"><span class="profile-key">来源标题</span><span>${escapeHtml(item.sourceTitle || "—")}</span></div><div class="profile-row"><span class="profile-key">品牌/术式</span><span>${escapeHtml(item.brandOrModel || "—")}</span></div><div class="profile-row"><span class="profile-key">页面价格（采集时）</span><span>${escapeHtml(item.displayedPrice || "页面未展示")}</span></div><div class="profile-row"><span class="profile-key">页面咨询量（采集时）</span><span>${escapeHtml(item.recentConsultation || "页面未展示")}</span></div><div class="profile-row"><span class="profile-key">来源核验</span>${badge(item.sourceCollectionLabel || (item.collectedByClick?"来源页面已逐项核验":"待核验"),item.collectedByClick?"success":"warning")}</div></div><div class="guardrail">${icon("alert",14)}以上价格和咨询量采集于 2026-08-03，仅用于来源核验，不代表当前报价或实时咨询数据。</div>`)}
      ${card("审核与使用状态", `<div class="profile-list"><div class="profile-row"><span class="profile-key">审核环节</span><span>${knowledgeStageLabel(item.layer)}</span></div><div class="profile-row"><span class="profile-key">内容完整度</span><strong>${item.coverage}%</strong></div><div class="profile-row"><span class="profile-key">当前状态</span>${badge(item.status)}</div><div class="profile-row"><span class="profile-key">审核责任</span><span>医务部 + 合规部</span></div></div><div class="guardrail">${icon("shield",14)}${escapeHtml(item.complianceNote || "发布前须完成医务与合规审核")}</div>`)}
      ${card("来源与溯源", `<div class="source-list"><div><span>${icon("globe",16)}</span><div><strong>百度项目卡片</strong><small>采集于 ${formatDate(item.updatedAt)}</small></div>${badge("来源已留存","success")}</div></div>${sourceLink}`)}
    </aside></div>
  </div>`;
}

function knowledgeDetail(id) {
  const item = store.state.knowledge.find((knowledge)=>knowledge.id===id);
  if (!item) return notFound("知识条目",id,"knowledge");
  if (item.sourceId) return projectKnowledgeDetail(item);
  const matchText = (value) => JSON.stringify(value || "").toLowerCase();
  const keywords = [item.id, item.title, item.project].filter(Boolean).map((value) => String(value).toLowerCase());
  const isRelated = (value) => keywords.some((keyword) => matchText(value).includes(keyword));
  const affectedAgents = (store.state.agents || []).filter((agent) => isRelated(agent.knowledge) || isRelated(agent.skills));
  const affectedJourneys = (store.state.journeys || []).filter((journey) => isRelated(journey.nodes) || isRelated(journey.name));
  const affectedTemplates = configurationRecords("message_template").filter((template) => isRelated([template.name, template.scope, template.content]));
  const citationCount = (store.state.audit || []).filter((audit) => isRelated([audit.object, audit.result])).length;
  const sourceTitle = item.sourceTitle || item.sourceReference || "尚未登记原始资料";
  const sourceStatus = item.sourceTitle || item.sourceReference ? "待来源核验" : "待补充来源";
  return `<div class="page">${knowledgeBackLink}${pageHead("知识详情", item.title, `当前版本 ${item.version} · ${item.project} · 更新于 ${relativeTime(item.updatedAt)}`, `${item.status==="待合规审核"?`<button class="btn primary" data-action="approve-knowledge" data-id="${item.id}">进入审批</button>`:item.status==="已发布"?`<button class="btn danger" data-action="unpublish-knowledge" data-id="${item.id}">下架</button>`:""}`)}
    <section class="detail-hero"><div class="object-icon">${icon("database",23)}</div><div><div class="row">${badge(item.status,item.status==="已发布"?"success":"warning")}${badge(knowledgeStageLabel(item.layer),"brand")}${badge(riskLabel(item.risk,item.riskLabel),item.risk==="H3"?"danger":item.risk==="H2"?"warning":"outline")}</div><h2>${item.title}</h2><p>${item.excerpt}</p></div><div class="object-actions"><a class="btn" href="#/knowledge/evaluations">查看评测状态</a></div></section>
    <div class="object-tabs"><button class="active">知识正文</button><span class="caption">来源与版本信息见本页</span><a href="#/knowledge/audit">使用记录</a></div>
    <div class="grid entity-layout"><div class="stack">
      ${card("可回答范围", `<div class="knowledge-content"><h3>一般项目说明</h3><p>${item.excerpt}</p><h3>回答原则</h3><ul><li>只解释一般原理、流程、常见体验与到院评估方式。</li><li>不根据照片、描述或历史信息判断个体适用性。</li><li>涉及异常、用药、禁忌或效果承诺时停止回答并转人工。</li></ul><h3>标准转人工表达</h3><p>“我可以先为您说明一般项目信息；您问到的个体适用性需要由医生结合实际情况评估，我为您转接工作人员协助。”</p></div>`)}
      ${card("来源与版本依据", `<div class="source-list"><div><span>${icon("globe",16)}</span><div><strong>${escapeHtml(sourceTitle)}</strong><small>最近更新：${formatDate(item.updatedAt)}</small></div>${badge(sourceStatus,sourceStatus === "待来源核验" ? "warning" : "outline")}</div><div><span>${icon("users",16)}</span><div><strong>${escapeHtml(item.owner || "待分配审核人")}</strong><small>当前审核状态以本页“审核与使用状态”为准</small></div>${badge(item.status==="已发布"?"已通过":"待完成",item.status==="已发布"?"success":"warning")}</div></div>`)}
    </div><aside class="stack">
      ${card("审核与使用状态", `<div class="profile-list"><div class="profile-row"><span class="profile-key">审核环节</span><span>${knowledgeStageLabel(item.layer)}</span></div><div class="profile-row"><span class="profile-key">内容风险</span>${badge(riskLabel(item.risk,item.riskLabel),item.risk==="H3"?"danger":item.risk==="H2"?"warning":"outline")}</div><div class="profile-row"><span class="profile-key">内容完整度</span><strong>${item.coverage}%</strong></div><div class="profile-row"><span class="profile-key">使用状态</span>${badge(item.status)}</div></div>`)}
      ${card("影响范围", `<div class="impact-list"><div><span class="responsibility-icon">${icon("bot",15)}</span><div><strong>${affectedAgents.length} 个关联AI员工</strong><small>按当前岗位知识范围字段匹配</small></div></div><div><span class="responsibility-icon">${icon("route",15)}</span><div><strong>${affectedJourneys.length} 条关联旅程</strong><small>按当前旅程名称与步骤文本匹配</small></div></div><div><span class="responsibility-icon">${icon("message",15)}</span><div><strong>${affectedTemplates.length} 条关联话术模板</strong><small>当前审计中可识别引用 ${citationCount} 次</small></div></div></div>`)}
    </aside></div></div>`;
}

function connectorDetail(id) {
  const connector = store.state.connectors.find((item)=>item.id===id);
  if (!connector) return notFound("连接器",id,"integrations");
  const lastChecked = connector.lastCheckedAt ? relativeTime(connector.lastCheckedAt) : "未检查";
  return `<div class="page">${pageHead("连接器详情", `${connector.name}连接器`, `${connector.vendor} · ${connector.direction}`, `<a class="btn" href="#/integrations">返回连接器</a><button class="btn primary" data-action="test-connector" data-id="${connector.id}">${icon("refresh",15)}检查配置</button>`)}
    <section class="detail-hero"><div class="object-icon">${icon(connector.icon || "database",23)}</div><div><div class="row">${badge(connector.status || "待接入")}${badge(connector.direction || "读取","outline")}</div><h2>${escapeHtml(connector.name)}</h2><p>这是本地保存的对接预留。当前没有保存密钥、字段契约、外部事件或外部业务数据。</p></div><div class="agent-hero-kpis"><div><strong>0</strong><span>已配置字段</span></div><div><strong>0</strong><span>同步事件</span></div><div><strong>否</strong><span>外部读写</span></div></div></section>
    <div class="object-tabs"><button class="active">配置概览</button><span class="caption">字段映射与事件日志待后续正式接入后开放</span></div>
    <div class="grid entity-layout"><div class="stack">${card("对接用途", `<div class="profile-list"><div class="profile-row"><span class="profile-key">服务商 / 系统</span><span>${escapeHtml(connector.vendor || "未填写")}</span></div><div class="profile-row"><span class="profile-key">数据方向</span><span>${escapeHtml(connector.direction || "未填写")}</span></div><div class="profile-row"><span class="profile-key">用途说明</span><span>${escapeHtml(connector.purpose || "未填写")}</span></div></div>`)}${card("字段契约", empty("尚未配置字段契约", "当前阶段未对接外部系统，不能预置或假定任何字段映射。"))}${card("事件记录", empty("暂无外部事件", "未接入外部渠道前，本地系统不会伪造同步结果。"))}</div><aside class="stack">${card("配置检查", `<div class="profile-list"><div class="profile-row"><span class="profile-key">最近检查</span><span>${lastChecked}</span></div><div class="profile-row"><span class="profile-key">检查结果</span><span>${escapeHtml(connector.connectionMessage || "尚未检查")}</span></div><div class="profile-row"><span class="profile-key">连接状态</span>${badge(connector.status || "待接入")}</div></div>`)}${card("安全边界", `<div class="guardrail">${icon("shield",14)}连接器配置仅保存名称、用途和数据方向。密钥、回调验签、字段契约和生产读写权限须在后续部署环境中另行配置与审核。</div>`)}</aside></div></div>`;
}

function segmentDetail(id) {
  const segment = configurationRecords("segment").find((item)=>item.id===id);
  if (!segment) return notFound("动态分群",id,"customers/segments");
  const members = segmentMembers(segment).sort((a,b)=>(b.interests[0]?.score||0)-(a.interests[0]?.score||0));
  const linkedJourney = store.state.journeys.find((item) => item.id === segment.journeyId);
  return `<div class="page">${pageHead("客户分群", segment.name, `实时计算 · 负责人：${segment.owner || "未分配"}`, `<a class="btn" href="#/customers/segments">返回分群</a><button class="btn primary" data-action="edit-segment" data-id="${escapeHtml(segment.id)}">编辑规则</button>`)}
    <section class="detail-hero"><div class="object-icon">${icon("filter",23)}</div><div><div class="row">${badge("自动更新","ai")}${badge(segment.owner,"outline")}</div><h2>${segment.name}</h2><p>${segment.rule}</p></div><div class="agent-hero-kpis"><div><strong>${members.length}</strong><span>当前客户</span></div><div><strong>${percent(members.length, store.state.customers.length)}%</strong><span>占已建档客户</span></div><div><strong>实时</strong><span>规则计算</span></div></div></section>
    <div class="grid entity-layout"><div class="stack">
      ${card("分群条件", `<div class="rule-builder"><div><span>1</span><strong>当前规则</strong><p>${escapeHtml(segment.rule)}</p></div><i>实时计算</i><div><span>2</span><strong>数据范围</strong><p>仅使用当前系统内已建档客户、项目兴趣与生命周期字段。</p></div><i>执行前校验</i><div><span>3</span><strong>自动化边界</strong><p>未唯一关联项目或授权失效时，不触发自动动作。</p></div></div>`)}
      ${card("命中客户", members.length ? table(["客户","当前环节","主兴趣","痛点","下一策略","详情"],members.map((customer)=>[customerCell(customer),`${customer.macroStage}/${customer.microStage}`,`${customer.interests[0]?.name||"—"} ${customer.interests[0]?.score||0}`,customer.pains[0],customer.nextAction.title,`<button class="link" data-customer="${customer.id}">客户360</button>`])) : empty("当前没有命中客户", "客户信息更新后会自动重新计算"))}
    </div><aside class="stack">
      ${card("关联动作", `<div class="impact-list"><div><span class="responsibility-icon">${icon("route",15)}</span><div><strong>${escapeHtml(linkedJourney?.name || "未关联旅程")}</strong><small>关联关系仅用于运营查看；不会自动将客户加入旅程</small></div></div><div><span class="responsibility-icon">${icon("users",15)}</span><div><strong>${escapeHtml(segment.owner || "未分配")}</strong><small>人工经营责任人</small></div></div><div><span class="responsibility-icon">${icon("chart",15)}</span><div><strong>当前命中 ${members.length} 位</strong><small>不以未接入的转化数据替代</small></div></div></div>`)}
      ${card("自动更新与保护", `<div class="profile-list"><div class="profile-row"><span class="profile-key">最近计算</span><span>${formatDate(store.state.dataQualityReport?.checkedAt || new Date().toISOString())}</span></div><div class="profile-row"><span class="profile-key">客户关系校验</span>${badge("已校验","success")}</div><div class="profile-row"><span class="profile-key">客户信息状态</span>${badge("按当前档案","success")}</div></div><div class="guardrail">${icon("shield",14)}授权失效或客户信息过期时，会立即停止自动动作。</div>`)}
    </aside></div></div>`;
}

export const renderEntityPage = (route, id) => ({
  task: taskDetail, conversation: conversationDetail, journey: journeyDetail, agent: agentDetail,
  physician: physicianDetail, "knowledge-item": knowledgeDetail, connector: connectorDetail, segment: segmentDetail
}[route]?.(id) || notFound("对象",id,"workbench"));
