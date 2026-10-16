import {
  clonePhaseOneManagementRoles,
  createLocalManagementBaseline,
  initialState,
  resolvePhaseOneManagementRole
} from "./data.js";
import { MANAGEMENT_DATA_MODEL_VERSION, normalizeManagementState } from "./management-data-governance.js";

const KEY = "huamei-ai-saas-mvp-v1";
const clone = (value) => JSON.parse(JSON.stringify(value));

const phaseOneRoleAssignment = (candidate = {}, fallbackId = "R-PRESALES") => {
  const role = resolvePhaseOneManagementRole(candidate, fallbackId);
  return { roleId:role.id, role:role.name };
};

// The role list is a product boundary in phase one, rather than an
// operator-maintained collection.  Always rebuild it from the fixed schema
// when data is hydrated or persisted so an old browser/server overlay cannot
// resurrect a third role or keep an obsolete permission assignment.
const enforcePhaseOneRoleModel = (state) => {
  if (!state || typeof state !== "object") return state;
  state.managementRoles = clonePhaseOneManagementRoles();
  state.currentRole = phaseOneRoleAssignment({ role:state.currentRole }, "R-ADMIN").role;
  state.managementUsers = (Array.isArray(state.managementUsers) ? state.managementUsers : []).map((user) => ({
    ...user,
    ...phaseOneRoleAssignment(user, "R-PRESALES")
  }));
  // Re-apply the agent invariant at every hydration and persistence boundary.
  // This protects against stale browser overlays as well as malformed operator
  // payloads that try to disable a mandatory guard after a normal form save.
  state.agents = normalizeAgentCollection(state.agents);
  return state;
};

const normalizeMessageTemplateAccess = (record = {}) => {
  if (record.kind !== "message_template") return record;
  return {
    ...record,
    // The template library is readable by sales staff.  A template can be
    // inserted only in an internal conversation composer and still never
    // triggers an external send by itself.
    presalesVisible:record.presalesVisible !== false,
    presalesInsertable:record.presalesInsertable !== false
  };
};

const OVERLAY_DYNAMIC_COLLECTIONS = Object.freeze([
  "managementUsers", "managementRoles", "customers", "tasks", "conversations",
  "journeys", "agents", "connectors", "audit", "handovers", "configurationRecords"
]);
const OVERLAY_OVERRIDE_COLLECTIONS = Object.freeze([
  ["products", "productOverrides"],
  ["physicians", "physicianOverrides"],
  ["knowledge", "knowledgeOverrides"]
]);
// These collections are maintained by their dedicated server workflows.  A
// phrase-template save must therefore send back the exact server snapshot,
// rather than the normalized display state held by this page.  In particular,
// the fixed phase-one role catalog is reconstructed for display but is not a
// writable management-domain overlay field.
const SERVER_PROTECTED_OVERLAY_COLLECTIONS = Object.freeze([
  "customers", "conversations", "tasks", "knowledgeOverrides", "managementUsers", "managementRoles"
]);

const canonicalState = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalState).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalState(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const runtimeBaseline = () => {
  const state = clone(createLocalManagementBaseline());
  normalizeManagementState(state, { priceEvidenceSources:state.priceEvidenceSources || initialState.priceEvidenceSources });
  return state;
};

const overlayItems = (baseItems = [], currentItems = []) => {
  const baseById = new Map(baseItems.filter((item) => item?.id).map((item) => [item.id, item]));
  return currentItems.filter((item) => {
    if (!item?.id) return false;
    const base = baseById.get(item.id);
    return !base || canonicalState(base) !== canonicalState(item);
  }).map(clone);
};

const mergeOverlayItems = (baseItems = [], overrides = []) => {
  const merged = new Map(baseItems.filter((item) => item?.id).map((item) => [item.id, clone(item)]));
  for (const incoming of Array.isArray(overrides) ? overrides : []) {
    if (!incoming?.id) continue;
    merged.set(incoming.id, { ...(merged.get(incoming.id) || {}), ...clone(incoming) });
  }
  return [...merged.values()];
};

const acquisitionCustomerIds = (state) => new Set((state.customers || [])
  .filter((customer) => customer?.origin === "acquisition_advisor")
  .map((customer) => customer.id));

// A management overlay contains real operator-owned data only. The acquisition
// service keeps public-advisor customers, handovers and sensitive messages in
// its own authenticated store, never in this management persistence channel.
export const buildManagementDomainOverlay = (state, base = runtimeBaseline(), serverProtectedOverlay = {}) => {
  const acquired = acquisitionCustomerIds(state);
  const omitAcquired = (collection) => (state[collection] || []).filter((item) => {
    if (collection === "customers") return !acquired.has(item.id);
    if (["tasks", "conversations"].includes(collection)) return !acquired.has(item.customerId);
    return collection !== "handovers";
  });
  const currentRole = phaseOneRoleAssignment({ role:state.currentRole }, "R-ADMIN").role;
  const overlay = { currentRole };
  for (const collection of OVERLAY_DYNAMIC_COLLECTIONS) overlay[collection] = clone(omitAcquired(collection));
  overlay.managementRoles = clonePhaseOneManagementRoles();
  overlay.managementUsers = (state.managementUsers || []).map((user) => ({
    ...clone(user),
    ...phaseOneRoleAssignment(user, "R-PRESALES")
  }));
  for (const [collection, overrideKey] of OVERLAY_OVERRIDE_COLLECTIONS) {
    overlay[overrideKey] = overlayItems(base[collection] || [], state[collection] || []);
  }
  for (const collection of SERVER_PROTECTED_OVERLAY_COLLECTIONS) {
    overlay[collection] = clone(Array.isArray(serverProtectedOverlay?.[collection]) ? serverProtectedOverlay[collection] : []);
  }
  return overlay;
};

export const applyManagementDomainOverlay = (overlay = {}, base = runtimeBaseline()) => {
  const state = clone(base);
  state.currentRole = String(overlay.currentRole || state.currentRole || "管理者").slice(0, 80) || "管理者";
  for (const collection of OVERLAY_DYNAMIC_COLLECTIONS) {
    state[collection] = clone(Array.isArray(overlay[collection]) ? overlay[collection] : []);
  }
  for (const [collection, overrideKey] of OVERLAY_OVERRIDE_COLLECTIONS) {
    state[collection] = mergeOverlayItems(base[collection] || [], overlay[overrideKey] || []);
  }
  enforcePhaseOneRoleModel(state);
  normalizeManagementState(state, { priceEvidenceSources:base.priceEvidenceSources || initialState.priceEvidenceSources });
  return state;
};

const HTML_DELIMITER_REPLACEMENTS = Object.freeze({
  "&":"＆", "<":"＜", ">":"＞", '"':"＂", "'":"＇", "`":"｀"
});
const URL_FIELD = /(?:url|uri|photo|avatar|video|cover|media)$/i;
const safeDisplayUrl = (value) => {
  const url = String(value || "").trim();
  if (!url || /[<>"'`\s]/.test(url)) return "";
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml)[,;]/i.test(url)) return url;
  if (/^(?:https?:\/\/|\/|\.\.?\/)/i.test(url)) return url;
  return /^[a-z0-9][a-z0-9_./?%=&+-]*$/i.test(url) ? url : "";
};
const safeDisplayText = (value) => String(value || "").replace(
  /[&<>"'`]/g,
  (character) => HTML_DELIMITER_REPLACEMENTS[character]
);

// 智能体岗位并不是一个可随意开关的展示卡片。这里把后台运营字段收敛成
// 一份可持久化的档案：职责、能力边界、知识范围、负责人、版本和评测门槛
// 都随同岗位保存。前端可以在此之上扩展表单，但不能借由缺字段或篡改状态
// 让一个尚未准入的岗位直接开始运行。
const AGENT_STATUS_DEFINITIONS = Object.freeze({
  draft:{ status:"草稿", statusCode:"draft" },
  pilot:{ status:"试运行", statusCode:"pilot" },
  active:{ status:"运行中", statusCode:"active" },
  disabled:{ status:"已停用", statusCode:"disabled" }
});
const AGENT_LEVEL_DEFINITIONS = Object.freeze({
  L2_CONTROLLED:{ level:"在规则范围内自动执行", levelCode:"L2_CONTROLLED" },
  L1_APPROVAL:{ level:"经工作人员确认后执行", levelCode:"L1_APPROVAL" },
  L4_MANDATORY:{ level:"核心合规控制（不可停用）", levelCode:"L4_MANDATORY" }
});
export const SYSTEM_MANDATORY_AGENT_IDS = Object.freeze(["A-06"]);
// A-01…A-06 are canonical runtime aliases used by the published agent API.
// Operator-created records must never reuse those ids merely because the
// management overlay starts empty on a clean installation.
const RESERVED_AGENT_IDS = Object.freeze([...new Set([
  ...SYSTEM_MANDATORY_AGENT_IDS,
  ...(initialState.agents || []).map((agent) => String(agent?.id || "")).filter(Boolean)
])]);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const agentText = (value, fallback = "", maxLength = 240) => safeDisplayText(String(value ?? fallback).trim()).slice(0, maxLength);
const agentTextList = (value, fallback = [], { maxItems = 24, maxLength = 160 } = {}) => {
  const values = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[\n；;]+/u) : fallback);
  return [...new Set(values
    .map((item) => agentText(item, "", maxLength))
    .filter(Boolean))].slice(0, maxItems);
};
const boundedScore = (value, fallback = null) => {
  if (value === "" || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(0, Number(numeric.toFixed(2)))) : fallback;
};
const normalizedStatusKey = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (["运行中", "启用", "active", "running", "enabled"].includes(token)) return "active";
  if (["试运行", "灰度中", "pilot", "canary"].includes(token)) return "pilot";
  if (["已停用", "停用", "disabled", "inactive"].includes(token)) return "disabled";
  return "draft";
};
const normalizedLevelKey = (value, { allowMandatory = false } = {}) => {
  const token = String(value || "").trim();
  let key = "L1_APPROVAL";
  if (["L2_CONTROLLED", "L2 受控执行", "在规则范围内自动执行"].includes(token)) key = "L2_CONTROLLED";
  if (["L4_MANDATORY", "L4 禁止绕过", "核心合规控制（不可停用）"].includes(token)) key = "L4_MANDATORY";
  return key === "L4_MANDATORY" && !allowMandatory ? "L1_APPROVAL" : key;
};

// A mandatory guard is either a shipped system identifier, an existing
// protected record, or a legacy L4 record brought in through a server overlay.
// New or edited ordinary roles cannot self-promote to L4 by passing a flag.
export const isSystemMandatoryAgent = (agent = {}) => SYSTEM_MANDATORY_AGENT_IDS.includes(String(agent.id || ""))
  || agent.systemManaged === true
  || agent.mandatory === true
  || agent.levelCode === "L4_MANDATORY"
  || agent.level === AGENT_LEVEL_DEFINITIONS.L4_MANDATORY.level;

const normalizeKnowledgeScope = (incoming = {}, existing = {}) => {
  const supplied = own(incoming, "knowledgeScope") ? incoming.knowledgeScope : existing.knowledgeScope;
  const base = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied : {};
  const suppliedLabels = Array.isArray(supplied) || typeof supplied === "string" ? supplied : (base.labels ?? base.scopes ?? base.scope ?? base.projects);
  const labels = agentTextList(
    own(incoming, "knowledgeScopeLabels") ? incoming.knowledgeScopeLabels : suppliedLabels,
    existing.knowledgeScope?.labels || (existing.knowledge ? [existing.knowledge] : []),
    { maxItems:32 }
  );
  const knowledgeIds = agentTextList(
    own(incoming, "knowledgeIds") ? incoming.knowledgeIds : (base.knowledgeIds ?? base.ids),
    existing.knowledgeScope?.knowledgeIds || [],
    { maxItems:80, maxLength:80 }
  );
  const projectScopes = agentTextList(
    own(incoming, "projectScopes") ? incoming.projectScopes : (base.projectScopes ?? base.projects),
    existing.knowledgeScope?.projectScopes || [],
    { maxItems:32 }
  );
  return {
    labels,
    knowledgeIds,
    projectScopes,
    releaseRequirement:agentText(
      own(incoming, "knowledgeReleaseRequirement") ? incoming.knowledgeReleaseRequirement : (base.releaseRequirement ?? existing.knowledgeScope?.releaseRequirement),
      "仅可读取已准入且在有效期内的知识",
      160
    ) || "仅可读取已准入且在有效期内的知识"
  };
};

const normalizeEvaluationGate = (incoming = {}, existing = {}) => {
  const supplied = own(incoming, "evaluationGate") ? incoming.evaluationGate : {};
  const suppliedObject = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied : {};
  const prior = existing.evaluationGate && typeof existing.evaluationGate === "object" ? existing.evaluationGate : {};
  const gate = { ...prior, ...suppliedObject };
  const minimumScore = boundedScore(
    own(incoming, "evaluationThreshold") ? incoming.evaluationThreshold : (gate.minimumScore ?? gate.minPassScore ?? existing.evaluationThreshold),
    95
  );
  const lastScore = boundedScore(
    own(incoming, "lastEval") ? incoming.lastEval : (gate.lastScore ?? existing.lastEval),
    null
  );
  // A caller cannot mark an unevaluated record as passed merely by writing a
  // status string. A numeric score plus the configured threshold is required.
  const status = lastScore === null ? "待评测" : (lastScore >= minimumScore ? "通过" : "未通过");
  return {
    suite:agentText(gate.suite ?? gate.dataset ?? "一期固定回归集", "一期固定回归集", 160) || "一期固定回归集",
    minimumScore,
    lastScore,
    status,
    evaluatedAt:lastScore === null ? null : agentText(gate.evaluatedAt ?? existing.evaluationGate?.evaluatedAt ?? "", "", 80) || null,
    evidenceRef:agentText(gate.evidenceRef ?? gate.evidenceId ?? "", "", 160)
  };
};

const meaningfulAgentField = (value) => {
  const text = agentText(value);
  return Boolean(text) && !/^(?:未命名|待配置|待分配|未分配|待完善)/u.test(text);
};

const agentConfigurationReady = (agent = {}) => Boolean(
  meaningfulAgentField(agent.name)
  && meaningfulAgentField(agent.role)
  && Array.isArray(agent.responsibilities) && agent.responsibilities.length
  && Array.isArray(agent.skills) && agent.skills.length
  && Array.isArray(agent.forbidden) && agent.forbidden.length
  && meaningfulAgentField(agent.knowledge)
  && Array.isArray(agent.knowledgeScope?.labels) && agent.knowledgeScope.labels.length
  && meaningfulAgentField(agent.owner)
  && meaningfulAgentField(agent.version)
  && boundedScore(agent.evaluationGate?.minimumScore, 0) > 0
);

const normalizeAgentRecord = (incoming = {}, {
  existing = {},
  id = "",
  allowIncomingMandatory = true,
  now = new Date().toISOString()
} = {}) => {
  const safeIncoming = incoming && typeof incoming === "object" ? incoming : {};
  const safeExisting = existing && typeof existing === "object" ? existing : {};
  const mandatory = isSystemMandatoryAgent(safeExisting)
    || (allowIncomingMandatory && isSystemMandatoryAgent(safeIncoming));
  const merged = { ...safeExisting, ...safeIncoming };
  const role = agentText(safeIncoming.role, safeExisting.role || "待配置职责", 160) || "待配置职责";
  const responsibilities = agentTextList(
    own(safeIncoming, "responsibilities") ? safeIncoming.responsibilities : (safeIncoming.responsibility ?? safeExisting.responsibilities ?? [safeExisting.role]),
    safeExisting.responsibilities || [safeExisting.role || role]
  );
  const skills = agentTextList(own(safeIncoming, "skills") ? safeIncoming.skills : safeExisting.skills, safeExisting.skills || []);
  const forbidden = agentTextList(
    own(safeIncoming, "forbidden") ? safeIncoming.forbidden : (safeIncoming.disabledCapabilities ?? safeExisting.forbidden ?? safeExisting.disabledCapabilities),
    safeExisting.forbidden || safeExisting.disabledCapabilities || []
  );
  const knowledge = agentText(safeIncoming.knowledge, safeExisting.knowledge || "待配置知识范围", 160) || "待配置知识范围";
  const knowledgeScope = normalizeKnowledgeScope(safeIncoming, { ...safeExisting, knowledge });
  const evaluationGate = normalizeEvaluationGate(safeIncoming, safeExisting);
  const requestedLevel = safeIncoming.levelCode ?? safeIncoming.level ?? safeExisting.levelCode ?? safeExisting.level;
  const levelDefinition = AGENT_LEVEL_DEFINITIONS[mandatory
    ? "L4_MANDATORY"
    : normalizedLevelKey(requestedLevel, { allowMandatory:false })];
  const requestedStatus = AGENT_STATUS_DEFINITIONS[normalizedStatusKey(safeIncoming.status ?? safeIncoming.statusCode ?? safeExisting.status ?? safeExisting.statusCode)];
  const record = {
    ...merged,
    id:String(id || safeExisting.id || safeIncoming.id || "").slice(0, 80),
    name:agentText(safeIncoming.name, safeExisting.name || "未命名智能体", 160) || "未命名智能体",
    role,
    responsibilities,
    skills,
    forbidden:mandatory ? [...new Set([...forbidden, "关闭核心门禁", "绕过医疗与隐私规则"])] : forbidden,
    disabledCapabilities:mandatory ? [...new Set([...forbidden, "关闭核心门禁", "绕过医疗与隐私规则"])] : forbidden,
    knowledge,
    knowledgeScope,
    owner:agentText(safeIncoming.owner, safeExisting.owner || "", 120),
    ownerId:agentText(safeIncoming.ownerId, safeExisting.ownerId || "", 120),
    version:agentText(safeIncoming.version, safeExisting.version || "v0.1", 80) || "v0.1",
    evaluationGate,
    evaluationThreshold:evaluationGate.minimumScore,
    lastEval:evaluationGate.lastScore,
    level:levelDefinition.level,
    levelCode:levelDefinition.levelCode,
    status:requestedStatus.status,
    statusCode:requestedStatus.statusCode,
    systemManaged:mandatory,
    mandatory,
    allowDisable:!mandatory,
    allowDelete:!mandatory,
    activeCustomers:Number(safeExisting.activeCustomers ?? 0) || 0,
    todayActions:Number(safeExisting.todayActions ?? 0) || 0,
    successRate:boundedScore(safeExisting.successRate, 0),
    takeoverRate:boundedScore(safeExisting.takeoverRate, 0),
    createdAt:agentText(safeExisting.createdAt || safeIncoming.createdAt || now, now, 80) || now,
    updatedAt:now
  };
  if (mandatory) {
    Object.assign(record, AGENT_STATUS_DEFINITIONS.active);
  } else if (record.statusCode === "active" && (!agentConfigurationReady(record) || record.evaluationGate.status !== "通过")) {
    Object.assign(record, AGENT_STATUS_DEFINITIONS.draft);
  } else if (record.statusCode === "pilot" && !agentConfigurationReady(record)) {
    Object.assign(record, AGENT_STATUS_DEFINITIONS.draft);
  }
  return sanitizeDisplayData(record);
};

const normalizeAgentCollection = (agents = []) => {
  const seen = new Set();
  return (Array.isArray(agents) ? agents : []).filter((agent) => {
    const id = String(agent?.id || "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((agent) => normalizeAgentRecord(agent, { existing:agent, id:agent.id }));
};

const nextAgentId = (agents = []) => {
  const used = new Set((agents || []).map((agent) => String(agent?.id || "")));
  let number = Math.max(0, ...(agents || []).map((agent) => Number(String(agent?.id || "").replace(/^A-/iu, "")) || 0)) + 1;
  while (used.has(`A-${String(number).padStart(2, "0")}`) || RESERVED_AGENT_IDS.includes(`A-${String(number).padStart(2, "0")}`)) number += 1;
  return `A-${String(number).padStart(2, "0")}`;
};

const agentAudit = (state, { action, agent, result, severity = "中", now = new Date().toISOString() }) => {
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  state.audit.unshift({
    id:`L-AGENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at:now,
    actor:"当前管理员",
    action,
    object:`${agent?.id || "未知智能体"} ${agent?.name || ""}`.trim(),
    result:agentText(result, "已记录", 360),
    severity
  });
};

const agentHasAssignments = (state, agent = {}) => (state.customers || []).some((customer) => {
  const assigned = String(customer?.agent || "").trim();
  return assigned && (assigned === agent.name || assigned === agent.id);
});

// The management console must never mix server-classified test records into
// an operator's live queue.  A customer's display name is user-entered data,
// so words such as “测试” or “演示” must not change the operational visibility
// of an otherwise production lead (or hide its linked conversation).
const isExplicitAcquisitionTestCustomer = (customer = {}) => customer?.origin === "acquisition_advisor"
  && customer.dataClassification === "test";

// Several legacy management views render structured state with innerHTML.
// Normalize every browser-persisted, operator-entered and server-fetched value
// at that trust boundary as a second defense in addition to sink escaping.
export const sanitizeDisplayData = (value, key = "", depth = 0) => {
  if (depth > 24) return null;
  if (typeof value === "string") return URL_FIELD.test(key) ? safeDisplayUrl(value) : safeDisplayText(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeDisplayData(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .slice(0, 500)
    .map(([childKey, childValue]) => [childKey, sanitizeDisplayData(childValue, childKey, depth + 1)]));
  return value;
};

const AGENT_LEVEL_COPY = {
  "L2 受控执行": { level: "在规则范围内自动执行", levelCode: "L2_CONTROLLED" },
  "L1 审批执行": { level: "经工作人员确认后执行", levelCode: "L1_APPROVAL" },
  "L4 禁止绕过": { level: "核心合规控制（不可停用）", levelCode: "L4_MANDATORY" }
};

const migrateAgentCopy = (agent = {}) => {
  const mappedLevel = AGENT_LEVEL_COPY[agent.level];
  return {
    ...agent,
    ...(mappedLevel || {}),
    ...(agent.status === "灰度中" ? { status: "试运行", statusCode: "pilot" } : {})
  };
};

const connectorHasVerifiedLiveTelemetry = (connector = {}) => connector.connectionMode === "live"
  && connector.statusCode === "connected"
  && connector.telemetryAvailable === true;

const migrateConnectorTruth = (connector = {}) => {
  if (connectorHasVerifiedLiveTelemetry(connector)) return connector;
  return {
    ...connector,
    vendor: connector.vendor === "待时代之美确认" ? "待配置" : connector.vendor,
    status: "待接入",
    statusCode: "not_connected",
    lastSync: null,
    latency: "—",
    successRate: null,
    records: 0,
    telemetryAvailable: false,
    connectionMessage: "尚未配置连接信息"
  };
};

const migrateCustomerCopy = (customer = {}) => ({
  ...customer,
  timeline: Array.isArray(customer.timeline) ? customer.timeline.map((entry) => entry.detail === "交易与项目完成状态由收银/预约模拟连接器回写。"
    ? { ...entry, detail: "项目完成信息已由工作人员登记，待业务系统接入后自动同步。", actor: "售后中心" }
    : entry) : []
});

const legacyCatalogSeedIds = Object.freeze({
  physicians:new Set(["DR-001", "DR-002", "DR-003", "DR-004", "DR-005", "DR-006"]),
  products:new Set(["P-001", "P-002", "P-003"]),
  prices:new Set(["PR-001", "PR-002", "PR-003"])
});

// The management UI carries a reviewed *import catalog* generated from the
// internal Huamei v1 package. It is intentionally separate from the public
// answer-release workflow: catalog presence does not make an item usable by
// the advisor. Preserve local entries while removing only the old demo seeds.
const migrateKnowledgeCatalog = (state, base, { refreshAutomaticPriceReferences = false } = {}) => {
  const importVersion = base.meta?.knowledgeCatalogImportVersion || "";
  const alreadyImported = (state.products || []).some((item) => item?.importSource === "华美智能体知识库_v1")
    && (state.physicians || []).some((item) => item?.importSource === "华美智能体知识库_v1")
    && (state.priceEvidenceSources || []).some((item) => item?.importSource === "华美智能体知识库_v1");
  if (state.meta?.knowledgeCatalogImportVersion === importVersion && alreadyImported && !refreshAutomaticPriceReferences) return false;

  const localPhysicians = (state.physicians || []).filter((item) => !legacyCatalogSeedIds.physicians.has(item?.id) && item?.importSource !== "华美智能体知识库_v1");
  const localProducts = (state.products || []).filter((item) => !legacyCatalogSeedIds.products.has(item?.id) && item?.importSource !== "华美智能体知识库_v1");
  const localPriceEvidenceSources = (state.priceEvidenceSources || []).filter((item) => item?.importSource !== "华美智能体知识库_v1");
  state.physicians = [...base.physicians, ...localPhysicians];
  const existingImportedProducts = new Map((state.products || [])
    .filter((item) => item?.importSource === "华美智能体知识库_v1")
    .map((item) => [item.id, item]));
  state.products = [...base.products.map((baseProduct) => {
    const existing = existingImportedProducts.get(baseProduct.id);
    if (!existing) return baseProduct;
    const merged = { ...baseProduct, ...existing };
    // Preserve a verified manual price, but refresh any value that was derived
    // from an earlier source import. This prevents an improved matcher from
    // leaving stale auto-matched values in the operating catalog.
    // A price is protected from source refresh only after an operator has
    // explicitly maintained it *and* completed the price review. This lets a
    // matcher correction remove an unverified legacy value, while preserving
    // a genuinely approved manual price.
    const verifiedManualPrice = existing.priceOrigin === "人工维护"
      && existing.priceApprovalStatus === "已通过"
      && Boolean(String(existing.price || "").trim());
    if (!verifiedManualPrice) {
      merged.price = baseProduct.price;
      merged.originalPrice = baseProduct.originalPrice;
      merged.priceType = baseProduct.priceType;
      merged.priceApplicableScope = baseProduct.priceApplicableScope;
      merged.priceApprovalStatus = baseProduct.priceApprovalStatus;
      merged.priceOrigin = baseProduct.priceOrigin;
    }
    merged.referencePrice = baseProduct.referencePrice;
    merged.referenceOriginalPrice = baseProduct.referenceOriginalPrice;
    merged.referencePriceSourcePath = baseProduct.referencePriceSourcePath;
    merged.referencePriceExcerpt = baseProduct.referencePriceExcerpt;
    return merged;
  }), ...localProducts];
  state.priceEvidenceSources = [...base.priceEvidenceSources, ...localPriceEvidenceSources];
  state.meta.knowledgeCatalogImportVersion = importVersion;
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  const catalogAudit = state.audit.find((item) => item?.action === "知识库目录批量导入" && item?.object === "华美智能体知识库_v1");
  const importResult = `已导入 ${base.physicians.length} 位医师、${base.products.length} 个产品项目和 ${base.priceEvidenceSources.length} 组原始价目证据；产品价格统一在产品档案维护`;
  if (catalogAudit) {
    catalogAudit.at = new Date().toISOString();
    catalogAudit.result = importResult;
  } else {
    state.audit.unshift({
      id:"L-KNOWLEDGE-CATALOG-V2",
      at:new Date().toISOString(),
      actor:"知识库导入服务",
      action:"知识库目录批量导入",
      object:"华美智能体知识库_v1",
      result:importResult,
      severity:"高"
    });
  }
  return true;
};

// 产品和价格资料最初由知识目录建档，但进入后台后应按运营对象维护。
// 此迁移只补齐运营字段，不覆盖运营人员已填写的值，也不改变对客准入门禁。
const migrateCatalogOperatingModel = (state, base) => {
  let changed = false;
  const productDefaults = {
    productCode:"待编", serviceType:"医美项目", salesStatus:"待维护", status:"草稿",
    approvalStatus:"待审核", owner:"待分配", branch:"全院", channel:"全渠道",
    highlights:"待维护", description:"待完善", priceType:"未录入价格", price:"",
    originalPrice:"", priceApplicableScope:"", priceApprovalStatus:"待核验", priceOrigin:"未匹配",
    priceEffectiveAt:"", priceExpiresAt:"", priceCount:0, customerFacing:false
  };
  state.products = (state.products || []).map((item) => {
    const next = { ...productDefaults, ...item };
    if (item?.importSource && item.status === "待审核") next.status = "草稿";
    if (JSON.stringify(next) !== JSON.stringify(item)) changed = true;
    return next;
  });
  if (state.meta.catalogOperatingModelVersion !== base.meta.catalogOperatingModelVersion) {
    state.meta.catalogOperatingModelVersion = base.meta.catalogOperatingModelVersion;
    changed = true;
  }
  if (changed) {
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    const audit = state.audit.find((item) => item?.action === "产品与价格运营模型升级");
    const result = "产品档案成为价格唯一维护入口；原始价目资料仅作为可追溯证据，对客发布仍需审核";
    if (audit) { audit.at = new Date().toISOString(); audit.result = result; }
    else state.audit.unshift({
      id:"L-CATALOG-OPERATING-MODEL-V2", at:new Date().toISOString(), actor:"系统服务",
      action:"产品与价格运营模型升级", object:"产品与价格目录", result, severity:"中"
    });
  }
  return changed;
};

const migrateBusinessCopy = (state, base) => {
  state.tasks = Array.isArray(state.tasks) ? state.tasks.map((task) => task.source === "NBA"
    ? { ...task, source: "下一最佳动作", sourceCode: "next_best_action" }
    : task) : clone(base.tasks);
  state.customers = Array.isArray(state.customers) ? state.customers.map(migrateCustomerCopy) : clone(base.customers);
  state.agents = normalizeAgentCollection(Array.isArray(state.agents)
    ? state.agents.map(migrateAgentCopy)
    : clone(base.agents));
  // 补齐系统内置的旅程定义，但不丢弃运营人员新增的本地旅程和其已维护字段。
  // 客户档案引用的旅程必须先有对应配置，才能进入自动执行链路。
  const persistedJourneys = new Map((state.journeys || []).map((item) => [item?.id, item]));
  const systemJourneyIds = new Set(base.journeys.map((item) => item.id));
  state.journeys = [
    ...base.journeys.map((item) => ({ ...item, ...(persistedJourneys.get(item.id) || {}) })),
    ...(state.journeys || []).filter((item) => item?.id && !systemJourneyIds.has(item.id))
  ];
  state.connectors = Array.isArray(state.connectors) ? state.connectors.map(migrateConnectorTruth) : clone(base.connectors);
  state.meta.version = base.meta.version;
  state.meta.businessCopyVersion = base.meta.businessCopyVersion;
  return state;
};

const browserPersistableState = (state) => {
  const acquisitionCustomerIds = new Set((state.customers || [])
    .filter((customer) => customer.origin === "acquisition_advisor")
    .map((customer) => customer.id));
  return {
    ...state,
    customers:(state.customers || []).filter((customer) => !acquisitionCustomerIds.has(customer.id)),
    conversations:(state.conversations || []).filter((conversation) => !acquisitionCustomerIds.has(conversation.customerId)),
    tasks:(state.tasks || []).filter((task) => !acquisitionCustomerIds.has(task.customerId)),
    handovers:[]
  };
};

class Store extends EventTarget {
  constructor() {
    super();
    this.baseState = runtimeBaseline();
    this.state = this.load();
    this.serverRevision = 0;
    this.managementHydrated = false;
    this.serverProtectedOverlay = {};
  }

  load() {
    // A prior version used browser localStorage for management mutations.
    // Discard it rather than silently carrying mock or potentially sensitive
    // records into the server-backed system. The API hydrates real records
    // immediately after application boot.
    try { localStorage.removeItem(KEY); } catch {}
    return clone(this.baseState);
  }

  save(source = "user") {
    enforcePhaseOneRoleModel(this.state);
    normalizeManagementState(this.state, { priceEvidenceSources:this.baseState.priceEvidenceSources || initialState.priceEvidenceSources });
    this.state.meta.lastSync = new Date().toISOString();
    this.dispatchEvent(new CustomEvent("change", { detail: { state:this.state, source } }));
  }

  reset() {
    this.state = clone(this.baseState);
    this.serverRevision = 0;
    this.managementHydrated = false;
    this.serverProtectedOverlay = {};
    this.save("management-reset");
  }

  managementOverlay() {
    return buildManagementDomainOverlay(this.state, this.baseState, this.serverProtectedOverlay);
  }

  hydrateManagementOverlay(record = {}) {
    const sanitizedOverlay = sanitizeDisplayData(record.overlay || {});
    this.state = applyManagementDomainOverlay(sanitizedOverlay, this.baseState);
    this.serverRevision = Number(record.revision) || 0;
    this.managementHydrated = true;
    this.serverProtectedOverlay = Object.fromEntries(SERVER_PROTECTED_OVERLAY_COLLECTIONS.map((collection) => [
      collection,
      clone(Array.isArray(sanitizedOverlay?.[collection]) ? sanitizedOverlay[collection] : [])
    ]));
    this.state.meta.lastSync = record.updated_at || this.state.meta.lastSync || null;
    this.dispatchEvent(new CustomEvent("change", { detail:{ state:this.state, source:"management-hydrate" } }));
  }

  customer(id) { return this.state.customers.find((item) => item.id === id); }
  task(id) { return this.state.tasks.find((item) => item.id === id); }
  conversation(id) { return this.state.conversations.find((item) => item.id === id); }
  handover(id) { return (this.state.handovers || []).find((item) => item.id === id); }
  physician(id) { return this.state.physicians.find((item) => item.id === id); }

  addPhysician(payload) {
    const nextNumber = Math.max(0, ...this.state.physicians.map((item) => Number(item.id.replace(/\D/g, "")) || 0)) + 1;
    const now = new Date().toISOString();
    const physician = sanitizeDisplayData({
      id: `DR-${String(nextNumber).padStart(3, "0")}`,
      avatar: null,
      consultationCount: 0,
      satisfaction: 0,
      updatedAt: now,
      ...payload
    });
    this.state.physicians.unshift(physician);
    this.state.audit.unshift({ id: `L-${Date.now()}`, at: now, actor: "当前用户", action: "新增医师", object: `${physician.id} ${physician.name}`, result: "成功", severity: "中" });
    this.save();
    return physician;
  }

  updatePhysician(id, patch) {
    const physician = this.physician(id);
    if (!physician) return;
    const now = new Date().toISOString();
    Object.assign(physician, sanitizeDisplayData(patch), { updatedAt: now });
    this.state.audit.unshift({ id: `L-${Date.now()}`, at: now, actor: "当前用户", action: "编辑医师", object: `${physician.id} ${physician.name}`, result: "成功", severity: "中" });
    this.save();
  }

  deletePhysician(id) {
    const physician = this.physician(id);
    if (!physician) return false;
    this.state.physicians = this.state.physicians.filter((item) => item.id !== id);
    const now = new Date().toISOString();
    this.state.audit.unshift({ id: `L-${Date.now()}`, at: now, actor: "当前用户", action: "删除医师", object: `${physician.id} ${physician.name}`, result: "成功", severity: "高" });
    this.save();
    return true;
  }

  updateCustomer(id, patch, timelineEvent) {
    const customer = this.customer(id);
    if (!customer) return;
    Object.assign(customer, sanitizeDisplayData(patch));
    if (timelineEvent) customer.timeline.unshift(sanitizeDisplayData({ id: `E-${Date.now()}`, occurredAt: new Date().toISOString(), ...timelineEvent }));
    this.save();
  }

  completeTask(id) {
    const task = this.task(id);
    if (!task) return;
    task.status = "已完成";
    task.completedAt = new Date().toISOString();
    const customer = this.customer(task.customerId);
    if (customer) customer.timeline.unshift({
      id: `E-${Date.now()}`, type: "task", title: `任务完成：${task.title}`, detail: `执行人：${task.assignee}；来源：${task.source}`, occurredAt: task.completedAt, actor: task.assignee, channel: "系统", tone: "positive"
    });
    this.save();
  }

  addTask(payload) {
    this.state.tasks.unshift(sanitizeDisplayData({ id: `T-${Date.now()}`, status: "待处理", ...payload }));
    this.save();
  }

  addJourney(payload = {}) {
    const now = new Date().toISOString();
    const sequence = (this.state.journeys || []).length + 1;
    const journey = sanitizeDisplayData({
      id:`J-${String(Date.now()).slice(-8)}`,
      name:"未命名旅程",
      stage:"售前",
      status:"草稿",
      version:"v0.1",
      owner:"",
      runtimeMembers:0,
      runtimeRunningMembers:0,
      conversion:null,
      updatedAt:now,
      nodes:["开始条件", "合规检查", "人工任务", "结束"],
      ...payload
    });
    this.state.journeys.unshift(journey);
    this.state.audit.unshift({
      id:`L-${Date.now()}`,
      at:now,
      actor:"当前用户",
      action:"新建旅程草稿",
      object:`${journey.id} ${journey.name}`,
      result:"草稿已创建，尚未运行",
      severity:"中"
    });
    this.save();
    return journey;
  }

  createConversationDraft({ customerId, channel = "企业微信" } = {}) {
    const customer = this.customer(customerId);
    if (!customer) return null;
    const now = new Date().toISOString();
    const conversation = sanitizeDisplayData({
      id: `V-${Date.now()}`,
      customerId: customer.id,
      channel,
      status: "待人工",
      mode: "人工",
      unread: 0,
      lastMessage: "已创建会话草稿，尚未向客户发送消息",
      updatedAt: now,
      messages: []
    });
    this.state.conversations.unshift(conversation);
    customer.timeline.unshift({
      id: `E-${Date.now()}`,
      type: "conversation",
      title: `${channel}人工会话草稿已创建`,
      detail: "已创建会话草稿，尚未向客户发送任何消息。",
      occurredAt: now,
      actor: "当前用户",
      channel: "系统",
      tone: "neutral"
    });
    this.state.audit.unshift({
      id: `L-${Date.now()}`,
      at: now,
      actor: "当前用户",
      action: "创建人工会话草稿",
      object: conversation.id,
      result: "未触达客户",
      severity: "低"
    });
    this.save();
    return conversation;
  }

  addKnowledgeDraft(payload = {}) {
    const nextNumber = Math.max(0, ...this.state.knowledge.map((item) => Number(String(item.id).replace(/\D/g, "")) || 0)) + 1;
    const now = new Date().toISOString();
    const item = sanitizeDisplayData({
      id: `K-${String(nextNumber).padStart(3, "0")}`,
      title: "未命名知识草稿",
      project: "通用",
      layer: "内部运营知识",
      layerCode: "L2_INTERNAL",
      status: "待医务与合规审核",
      version: "0.1",
      risk: "H1",
      riskCode: "H1",
      riskLabel: "常规审核",
      owner: "当前用户",
      updatedAt: now,
      coverage: 0,
      customerFacing: false,
      excerpt: "",
      sections: [],
      ...payload
    });
    this.state.knowledge.unshift(item);
    this.state.audit.unshift({
      id: `L-${Date.now()}`,
      at: now,
      actor: "当前用户",
      action: "新增知识草稿",
      object: `${item.id} ${item.title}`,
      result: "待医务与合规审核",
      severity: item.risk === "H3" ? "高" : "中"
    });
    this.save();
    return item;
  }

  addConnector(payload = {}) {
    const nextNumber = Math.max(0, ...this.state.connectors.map((item) => Number(String(item.id).replace(/\D/g, "")) || 0)) + 1;
    const now = new Date().toISOString();
    const connector = sanitizeDisplayData({
      id: `I-${String(nextNumber).padStart(2, "0")}`,
      name: "未命名连接器",
      vendor: "待配置",
      status: "待接入",
      statusCode: "not_connected",
      direction: "读取",
      lastSync: null,
      latency: "—",
      successRate: null,
      records: 0,
      telemetryAvailable: false,
      connectionMessage: "尚未配置连接信息",
      icon: "database",
      createdAt: now,
      ...payload
    });
    this.state.connectors.unshift(connector);
    this.state.audit.unshift({
      id: `L-${Date.now()}`,
      at: now,
      actor: "当前用户",
      action: "新增连接器配置",
      object: `${connector.id} ${connector.name}`,
      result: "待配置凭据与回调地址",
      severity: "中"
    });
    this.save();
    return connector;
  }

  addManagementUser(payload = {}) {
    const now = new Date().toISOString();
    const requestedRole = phaseOneRoleAssignment(payload, "R-PRESALES");
    const user = sanitizeDisplayData({
      id:`U-${Date.now()}`,
      status:"启用",
      updatedAt:now,
      ...payload,
      ...requestedRole
    });
    this.state.managementUsers = [user, ...(this.state.managementUsers || [])];
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"新增后台用户", object:`${user.name} · ${user.account}`, result:"本地管理系统已创建", severity:"高" });
    this.save();
    return user;
  }

  updateManagementUser(id, payload = {}) {
    const user = (this.state.managementUsers || []).find((item) => item.id === id);
    if (!user) return null;
    const now = new Date().toISOString();
    const requestedRole = phaseOneRoleAssignment({ ...user, ...payload }, "R-PRESALES");
    Object.assign(user, sanitizeDisplayData({
      ...payload,
      ...requestedRole,
      updatedAt:now
    }));
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"更新后台用户", object:`${user.name} · ${user.account}`, result:`状态：${user.status}；角色：${user.role || "未分配"}`, severity:"高" });
    this.save();
    return user;
  }

  addManagementRole() {
    // Phase one deliberately does not expose dynamic role creation.  Returning
    // null lets an accidental legacy action fail closed instead of creating an
    // unreviewed permission container.
    enforcePhaseOneRoleModel(this.state);
    return null;
  }

  addConfigurationRecord(payload = {}) {
    const now = new Date().toISOString();
    const record = sanitizeDisplayData(normalizeMessageTemplateAccess({
      id:`CFG-${Date.now()}`,
      kind:"general",
      name:"未命名配置",
      status:"草稿",
      createdAt:now,
      updatedAt:now,
      ...payload
    }));
    this.state.configurationRecords = [record, ...(this.state.configurationRecords || [])];
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"新增运营配置", object:`${record.kind} · ${record.name}`, result:`状态：${record.status}`, severity:"中" });
    this.save();
    return record;
  }

  updateConfigurationRecord(id, payload = {}) {
    const record = (this.state.configurationRecords || []).find((item) => item.id === id);
    if (!record) return null;
    const now = new Date().toISOString();
    Object.assign(record, sanitizeDisplayData(normalizeMessageTemplateAccess({ ...record, ...payload, updatedAt:now })));
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"更新运营配置", object:`${record.kind} · ${record.name}`, result:`状态：${record.status}`, severity:"中" });
    this.save();
    return record;
  }

  updateManagementRole() {
    // Fixed phase-one roles are documentation and enforcement policy, not a
    // mutable operating record.  Keep this method fail-closed for old UI links
    // or stale API payloads until a reviewed RBAC expansion is introduced.
    enforcePhaseOneRoleModel(this.state);
    return null;
  }

  addProduct(payload = {}) {
    const now = new Date().toISOString();
    const product = sanitizeDisplayData({
      id:`P-${Date.now()}`, productCode:"", serviceType:"医美项目", salesStatus:"待完善",
      status:"草稿", approvalStatus:"待审核", owner:"", branch:"", channel:"",
      highlights:"", description:"", priceType:"未录入价格", price:"", originalPrice:"",
      priceApplicableScope:"", priceApprovalStatus:"待核验", priceOrigin:"人工维护", priceEffectiveAt:"", priceExpiresAt:"",
      priceCount:0, customerFacing:false, updatedAt:now, ...payload
    });
    this.state.products = [product, ...(this.state.products || [])];
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"新增产品", object:product.name, result:"草稿", severity:"中" });
    this.save();
    return product;
  }

  updateProduct(id, patch = {}) {
    const product = (this.state.products || []).find((item) => item.id === id);
    if (!product) return null;
    const now = new Date().toISOString();
    const safePatch = sanitizeDisplayData(patch);
    const manuallyChangedPrice = Object.hasOwn(safePatch, "price") && String(safePatch.price || "") !== String(product.price || "");
    Object.assign(product, safePatch, { updatedAt:now, customerFacing:false });
    if (manuallyChangedPrice) product.priceOrigin = "人工维护";
    this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:"当前用户", action:"编辑产品", object:product.name, result:product.status || "草稿", severity:"中" });
    this.save();
    return product;
  }

  upsertAcquisitionSnapshot(snapshot = {}) {
    const safeSnapshot = sanitizeDisplayData(snapshot);
    const incremental = safeSnapshot.meta?.incremental === true;
    const authoritative = safeSnapshot.meta?.authoritative === true;
    const rawCustomers = Array.isArray(safeSnapshot.customers) ? safeSnapshot.customers : [];
    const explicitTestCustomerIds = new Set(rawCustomers.filter(isExplicitAcquisitionTestCustomer).map((item) => item.id));
    const customers = rawCustomers.filter((item) => !explicitTestCustomerIds.has(item.id));
    const conversations = (Array.isArray(safeSnapshot.conversations) ? safeSnapshot.conversations : [])
      .filter((item) => !explicitTestCustomerIds.has(item.customerId));
    const tasks = (Array.isArray(safeSnapshot.tasks) ? safeSnapshot.tasks : [])
      .filter((item) => !explicitTestCustomerIds.has(item.customerId));
    const persistedExplicitTestCustomerIds = new Set((this.state.customers || [])
      .filter(isExplicitAcquisitionTestCustomer)
      .map((item) => item.id));
    if (!authoritative && !customers.length && !conversations.length && !tasks.length && !persistedExplicitTestCustomerIds.size) return false;
    const before = JSON.stringify({
      customers:this.state.customers,
      conversations:this.state.conversations,
      tasks:this.state.tasks
    });
    // A successful full snapshot is the source of truth.  Keeping acquisition
    // rows that are absent from it mixes records from a previous process or
    // port into the current queue, which made refresh results non-repeatable.
    if (authoritative && !incremental) {
      const previousAcquisitionCustomerIds = acquisitionCustomerIds(this.state);
      this.state.customers = this.state.customers.filter((item) => !previousAcquisitionCustomerIds.has(item.id));
      this.state.conversations = this.state.conversations.filter((item) => !previousAcquisitionCustomerIds.has(item.customerId));
      this.state.tasks = this.state.tasks.filter((item) => !previousAcquisitionCustomerIds.has(item.customerId));
    }
    if (persistedExplicitTestCustomerIds.size) {
      this.state.customers = this.state.customers.filter((item) => !persistedExplicitTestCustomerIds.has(item.id));
      this.state.conversations = this.state.conversations.filter((item) => !persistedExplicitTestCustomerIds.has(item.customerId));
      this.state.tasks = this.state.tasks.filter((item) => !persistedExplicitTestCustomerIds.has(item.customerId));
    }
    const mergeById = (incoming = [], existing = []) => {
      const seen = new Set();
      return [...incoming, ...existing].filter((item) => item?.id && !seen.has(item.id) && seen.add(item.id));
    };
    const mergeConversationMessages = (existing = [], incoming = []) => {
      const byId = new Map();
      const keyFor = (message = {}) => message.id || `${message.from || "unknown"}:${message.at || ""}:${message.text || ""}`;
      for (const message of existing) byId.set(keyFor(message), message);
      // Incoming rows are authoritative for delivery/status changes. Stable
      // IDs make a replay safe when a reconnect overlaps the normal poll.
      for (const message of incoming) byId.set(keyFor(message), message);
      return [...byId.values()].sort((left, right) => {
        const leftSequence = Number.isInteger(left?.seq) ? left.seq : null;
        const rightSequence = Number.isInteger(right?.seq) ? right.seq : null;
        if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) return leftSequence - rightSequence;
        return Date.parse(left?.at || 0) - Date.parse(right?.at || 0);
      });
    };
    for (const incoming of customers) {
      const index = this.state.customers.findIndex((item) => item.id === incoming.id);
      if (index < 0) this.state.customers.unshift(incoming);
      else {
        const existing = this.state.customers[index];
        this.state.customers[index] = {
          ...existing,
          ...incoming,
          photo:incoming.photo || existing.photo || null,
          profile:{ ...existing.profile, ...incoming.profile },
          tags:[...new Set([...(incoming.tags || []), ...(existing.tags || [])])].slice(0, 10),
          timeline:mergeById(incoming.timeline, existing.timeline)
        };
      }
    }
    // 客户列表按“来的时间”排序：首次进入时间倒序。首次同步时新客户是逐个 unshift
    // 进来的，会把接口给的最新在前顺序整体反转，这里统一按时间重排以保持稳定。
    const arrivalTime = (item) => Date.parse(item?.stageEnteredAt || item?.createdAt || "") || 0;
    this.state.customers.sort((left, right) => arrivalTime(right) - arrivalTime(left));
    const liveExternalIds=new Set(conversations.filter(c=>c.id?.startsWith('V-LIVE-')).map(c=>c.externalConversationId));
    this.state.conversations=this.state.conversations.filter(c=>!liveExternalIds.has(c.externalConversationId)||conversations.some(n=>n.id===c.id));
    const incomingIds=new Set(customers.map(c=>c.id));
    this.state.customers=this.state.customers.filter(c=>!c.id?.startsWith('C-VISITOR-')||incomingIds.has(c.id));
    for (const incoming of conversations) {
      const index = this.state.conversations.findIndex((item) => item.id === incoming.id);
      if (index < 0) this.state.conversations.unshift(incoming);
      else {
        const existing = this.state.conversations[index];
        this.state.conversations[index] = {
          ...existing,
          ...incoming,
          ...(incremental ? { messages:mergeConversationMessages(existing.messages, incoming.messages) } : {})
        };
      }
    }
    for (const incoming of tasks) {
      const index = this.state.tasks.findIndex((item) => item.id === incoming.id);
      if (index < 0) this.state.tasks.unshift(incoming);
      else if (this.state.tasks[index].status !== "已完成") this.state.tasks[index] = { ...this.state.tasks[index], ...incoming };
    }
    const after = JSON.stringify({
      customers:this.state.customers,
      conversations:this.state.conversations,
      tasks:this.state.tasks
    });
    if (after === before) return false;
    this.save("acquisition-sync");
    return true;
  }

  replaceAcquisitionHandovers(handovers = []) {
    const normalized = Array.isArray(handovers)
      ? handovers.filter((item) => item?.id).map((item) => sanitizeDisplayData(item))
      : [];
    const before = JSON.stringify(this.state.handovers || []);
    const after = JSON.stringify(normalized);
    if (before === after) return false;
    this.state.handovers = normalized;
    this.save("acquisition-operations-sync");
    return true;
  }

  updateAcquisitionHandover(handover) {
    if (!handover?.id) return false;
    const list = Array.isArray(this.state.handovers) ? this.state.handovers : [];
    const index = list.findIndex((item) => item.id === handover.id);
    const safeHandover = sanitizeDisplayData(handover);
    if (index < 0) list.unshift(safeHandover);
    else list[index] = { ...list[index], ...safeHandover };
    this.state.handovers = list;
    this.save("acquisition-operations-sync");
    return true;
  }

  sendMessage(conversationId, text, mode = "人工") {
    const conversation = this.conversation(conversationId);
    if (!conversation) return;
    const now = new Date().toISOString();
    const safeText = safeDisplayText(text);
    conversation.messages.push({ from: mode === "人工" ? "staff" : "ai", text:safeText, at: now });
    conversation.lastMessage = safeText;
    conversation.updatedAt = now;
    conversation.status = mode === "人工" ? "人工处理中" : "AI处理中";
    conversation.unread = 0;
    const customer = this.customer(conversation.customerId);
    if (customer) {
      customer.timeline.unshift({ id: `E-${Date.now()}`, type: "conversation", title: `${conversation.channel}人工沟通记录已登记`, detail:safeText, occurredAt: now, actor: mode === "人工" ? customer.owner : customer.agent, channel: conversation.channel, tone: mode === "人工" ? "neutral" : "ai" });
      this.state.audit.unshift({ id:`L-${Date.now()}`, at:now, actor:mode === "人工" ? customer.owner || "当前用户" : customer.agent || "当前用户", action:"登记人工沟通记录", object:conversation.id, result:`渠道：${conversation.channel}；未触发外部发送`, severity:"中" });
    }
    this.save();
  }

  setConversationMode(id, mode) {
    const conversation = this.conversation(id);
    if (!conversation) return;
    conversation.mode = mode;
    conversation.status = mode === "人工" ? "人工处理中" : "AI处理中";
    this.save();
  }

  toggleJourney(id) {
    const journey = this.state.journeys.find((item) => item.id === id);
    if (!journey) return;
    journey.status = journey.status === "运行中" ? "已暂停" : "运行中";
    journey.updatedAt = new Date().toISOString();
    this.save();
  }

  publishJourney(id) {
    const journey = this.state.journeys.find((item) => item.id === id);
    if (!journey) return;
    if (Array.isArray(journey.draftCanvas?.nodes) && journey.draftCanvas.nodes.length >= 2) {
      journey.canvas = JSON.parse(JSON.stringify(journey.draftCanvas));
      journey.nodes = journey.canvas.nodes.map((node) => String(node.name || "").trim()).filter(Boolean);
      delete journey.draftCanvas;
      delete journey.draftVersion;
      delete journey.draftUpdatedAt;
    }
    journey.status = "运行中";
    journey.version = `v1.${Number(String(Date.now()).slice(-1))}`;
    journey.updatedAt = new Date().toISOString();
    this.save();
  }

  saveJourneyCanvas(id, canvas) {
    const journey = this.state.journeys.find((item) => item.id === id);
    const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
    if (!journey || nodes.length < 2) return false;
    const safeCanvas = JSON.parse(JSON.stringify({
      nodes:nodes.map((node, index) => ({
        id:String(node.id || `node-${index + 1}`),
        type:String(node.type || "action"),
        name:String(node.name || "未命名步骤").slice(0, 80),
        description:String(node.description || "").slice(0, 180),
        condition:String(node.condition || "").slice(0, 300),
        successAction:String(node.successAction || "").slice(0, 180),
        timeoutAction:String(node.timeoutAction || "").slice(0, 180),
        wait:String(node.wait || "").slice(0, 80),
        branchYes:String(node.branchYes || "继续下一步").slice(0, 80),
        branchNo:String(node.branchNo || "结束或转人工").slice(0, 80)
      }))
    }));
    const now = new Date().toISOString();
    if (journey.status === "草稿") {
      journey.canvas = safeCanvas;
      journey.nodes = safeCanvas.nodes.map((node) => node.name);
      delete journey.draftCanvas;
      delete journey.draftVersion;
      delete journey.draftUpdatedAt;
    } else {
      journey.draftCanvas = safeCanvas;
      journey.draftVersion = `${journey.version}-draft`;
      journey.draftUpdatedAt = now;
    }
    journey.updatedAt = now;
    this.state.audit.unshift({
      id:`L-${Date.now()}`,
      at:now,
      actor:this.state.currentRole || "当前用户",
      action:"保存旅程编排草稿",
      object:`${journey.id} ${journey.draftVersion || journey.version}`,
      result:journey.status === "草稿" ? "草稿已更新" : "已创建待发布版本",
      severity:"低"
    });
    this.save();
    return { draftVersion:journey.draftVersion || journey.version, status:journey.status };
  }

  addAgent(payload = {}) {
    const now = new Date().toISOString();
    const id = nextAgentId(this.state.agents || []);
    // New records cannot claim system ownership or L4 protection through a
    // browser payload. Only a shipped/migrated mandatory record may have that
    // status; every new role starts as an operator-owned draft unless its
    // configuration and evaluation evidence are complete.
    const agent = normalizeAgentRecord(payload, {
      id,
      allowIncomingMandatory:false,
      now
    });
    this.state.agents = [agent, ...(this.state.agents || [])];
    agentAudit(this.state, {
      action:"新增智能体",
      agent,
      result:`状态：${agent.status}；版本：${agent.version}；评测门槛：${agent.evaluationGate.minimumScore}分`,
      severity:"中",
      now
    });
    this.save("agent-add");
    return agent;
  }

  updateAgent(id, patch = {}) {
    const index = (this.state.agents || []).findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = this.state.agents[index];
    const now = new Date().toISOString();
    const requestedDisable = normalizedStatusKey(patch.status ?? patch.statusCode) === "disabled";
    const agent = normalizeAgentRecord(patch, {
      existing:current,
      id:current.id,
      // Protection must be inherited from the persisted record. An ordinary
      // operator cannot turn a record into a system guard by passing flags.
      allowIncomingMandatory:false,
      now
    });
    this.state.agents[index] = agent;
    const wasProtected = isSystemMandatoryAgent(current);
    const result = wasProtected && requestedDisable
      ? `已拒绝停用系统强制合规守门员；状态保持${agent.status}`
      : `状态：${agent.status}；版本：${agent.version}；评测：${agent.evaluationGate.status}（门槛${agent.evaluationGate.minimumScore}分）`;
    agentAudit(this.state, {
      action:wasProtected && requestedDisable ? "拒绝停用系统智能体" : "更新智能体",
      agent,
      result,
      severity:wasProtected && requestedDisable ? "高" : "中",
      now
    });
    this.save("agent-update");
    return agent;
  }

  deleteAgent(id) {
    const index = (this.state.agents || []).findIndex((item) => item.id === id);
    if (index < 0) return false;
    const agent = this.state.agents[index];
    const now = new Date().toISOString();
    if (isSystemMandatoryAgent(agent)) {
      agentAudit(this.state, {
        action:"拒绝删除系统智能体",
        agent,
        result:"系统强制合规守门员不可删除",
        severity:"高",
        now
      });
      this.save("agent-delete-rejected");
      return false;
    }
    if (agentHasAssignments(this.state, agent)) {
      agentAudit(this.state, {
        action:"拒绝删除智能体",
        agent,
        result:"仍有关联客户，请先完成转交或解除关联后再删除",
        severity:"高",
        now
      });
      this.save("agent-delete-rejected");
      return false;
    }
    this.state.agents.splice(index, 1);
    agentAudit(this.state, {
      action:"删除智能体",
      agent,
      result:`已删除版本${agent.version}；保留历史审计记录`,
      severity:"高",
      now
    });
    this.save("agent-delete");
    return true;
  }

  toggleAgent(id) {
    const agent = (this.state.agents || []).find((item) => item.id === id);
    if (!agent) return null;
    if (isSystemMandatoryAgent(agent)) {
      const now = new Date().toISOString();
      agentAudit(this.state, {
        action:"拒绝停用系统智能体",
        agent,
        result:"系统强制合规守门员不可关闭",
        severity:"高",
        now
      });
      this.save("agent-toggle-rejected");
      return null;
    }
    return this.updateAgent(id, { status:agent.status === "已停用" ? "运行中" : "已停用" });
  }

  updateKnowledge(id, status) {
    const item = this.state.knowledge.find((knowledge) => knowledge.id === id);
    if (!item) return false;
    const now = new Date().toISOString();
    if (item.sourceId && status === "待医务审核") {
      item.medicalReviewStatus = "in_review";
      item.complianceReviewStatus = "pending";
      item.reviewStatus = "医务审核中";
      item.reviewStatusCode = "medical_review";
    }
    if (item.sourceId && status === "待合规审核") {
      item.medicalReviewStatus = "approved";
      item.complianceReviewStatus = "in_review";
      item.reviewStatus = "合规审核中";
      item.reviewStatusCode = "compliance_review";
    }
    if (status === "已发布" && item.sourceId) {
      // 点击“合规通过并发布”本身就是合规责任人的确认动作。
      if (item.medicalReviewStatus === "approved" && item.complianceReviewStatus === "in_review") {
        item.complianceReviewStatus = "approved";
      }
      const dualReviewPassed = item.medicalReviewStatus === "approved" && item.complianceReviewStatus === "approved";
      if (!dualReviewPassed) {
        item.status = "待医务与合规审核";
        item.reviewStatus = "待医务与合规复核";
        item.reviewStatusCode = "pending_dual_review";
        item.customerFacing = false;
        item.allowedForCustomerResponse = false;
        item.updatedAt = now;
        this.state.audit.unshift({ id: `L-${Date.now()}`, at: now, actor: "当前用户", action: "发布知识", object: `${item.id} ${item.version}`, result: "未发布：需完成医务与合规双审", severity: "高" });
        this.save();
        return false;
      }
      item.reviewStatus = "双审通过";
      item.reviewStatusCode = "approved";
      item.customerFacing = true;
      item.allowedForCustomerResponse = true;
    }
    if (status !== "已发布" && item.sourceId) {
      item.customerFacing = false;
      item.allowedForCustomerResponse = false;
    }
    item.status = status;
    item.updatedAt = now;
    this.state.audit.unshift({ id: `L-${Date.now()}`, at: item.updatedAt, actor: "当前用户", action: status === "已发布" ? "发布知识" : "下架知识", object: `${item.id} ${item.version}`, result: status, severity: status === "已发布" ? "中" : "高" });
    this.save();
    return true;
  }

  testConnector(id) {
    const connector = this.state.connectors.find((item) => item.id === id);
    if (!connector) return { ok: false, message: "未找到连接器" };
    if (connectorHasVerifiedLiveTelemetry(connector)) {
      connector.connectionMessage = "请通过已配置的服务端连接器执行真实连接测试";
      connector.lastCheckedAt = new Date().toISOString();
      this.save();
      return { ok: false, message: connector.connectionMessage };
    }
    Object.assign(connector, migrateConnectorTruth(connector), {
      lastCheckedAt: new Date().toISOString(),
      connectionMessage: "尚未配置连接信息"
    });
    this.save();
    return { ok: false, message: connector.connectionMessage };
  }
}

export const store = new Store();
