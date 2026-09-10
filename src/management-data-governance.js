// 管理后台的本地演示数据来自多个运营模块。该文件只做“可证明的归一化”：
// 不猜测医师-项目关系，不把原始价目资料直接当作对客报价，也不删除未能
// 自动关联的历史数据。无法确定的内容会保留在待复核清单中。

export const MANAGEMENT_DATA_MODEL_VERSION = 2;
export const MANAGEMENT_DATA_QUALITY_VERSION = "management-data-quality.v2";

const asArray = (value) => Array.isArray(value) ? value : [];
const cleanText = (value) => String(value ?? "").trim();
const unique = (items = []) => [...new Set(items.filter(Boolean))];

export const canonicalKey = (value) => cleanText(value)
  .toLowerCase()
  .replace(/[\s\-—_·・/（）()［］\[\]【】,，。、“”"'‘’!！:：;；]/g, "");

// “线雕提升”与“线雕”等同于同一个服务主题；这里仅用于项目字典关联，
// 不会把不同的具体产品、价格或适用性结论合并。
export const projectKey = (value) => canonicalKey(value)
  .replace(/(?:项目|服务|治疗|提升|管理)$/g, "");

// 这些别名来自当前后台既有的项目字典，而不是模型推断；用于将同一项目的
// 常用口语称呼归入同一个项目主题，不涉及具体品牌、价格或适用性判断。
const PROJECT_ALIASES = Object.freeze({
  [projectKey("微拉美")]:projectKey("拉皮/微拉美"),
  [projectKey("拉皮")]:projectKey("拉皮/微拉美"),
  [projectKey("面部提升")]:projectKey("拉皮/微拉美"),
  [projectKey("埋线")]:projectKey("线雕")
});

const isPlaceholderPrice = (value) => !cleanText(value)
  || /^(?:待维护|待整理|未录入价格|—|-|暂无)$/u.test(cleanText(value));

const validDate = (value) => {
  const text = cleanText(value);
  return !text || Number.isFinite(Date.parse(text));
};

const addIssue = (issues, domain, code, severity, count, message) => {
  if (!count) return;
  issues.push({ id:`${domain}:${code}`, domain, code, severity, count, message });
};

const indexBy = (items, keyOf) => {
  const index = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const entries = index.get(key) || [];
    entries.push(item);
    index.set(key, entries);
  }
  return index;
};

const statusCode = (value, aliases, fallback) => aliases[cleanText(value)] || fallback;

const productStatusCode = (value) => statusCode(value, {
  "在售":"on_sale", "预售":"presale", "停售":"off_sale", "待维护":"to_maintain"
}, "draft");

const reviewStatusCode = (value) => statusCode(value, {
  "已通过":"approved", "审核中":"in_review", "待审核":"pending", "退回修改":"returned",
  "待业务、医务与合规核验":"pending_dual_review", "待核验":"pending_verification",
  "暂无可匹配价格资料":"no_evidence"
}, "pending");

const lifecycleStatusCode = (value) => statusCode(value, {
  "售前":"presales", "售中":"in_service", "售后":"after_service"
}, "unknown");

const buildProjectDictionary = (state) => {
  const rows = new Map();
  const register = ({ name, productId = "", knowledgeId = "", source = "" }) => {
    const displayName = cleanText(name);
    const key = projectKey(displayName);
    if (!key) return;
    const current = rows.get(key) || {
      id:`PD-${key.slice(0, 80)}`,
      canonicalName:displayName,
      aliases:[],
      productIds:[],
      knowledgeIds:[],
      sources:[]
    };
    current.aliases = unique([...current.aliases, displayName]);
    current.productIds = unique([...current.productIds, productId]);
    current.knowledgeIds = unique([...current.knowledgeIds, knowledgeId]);
    current.sources = unique([...current.sources, source]);
    // Prefer a concise source term to a longer generated title as the UI label.
    if (displayName.length < current.canonicalName.length) current.canonicalName = displayName;
    rows.set(key, current);
  };
  for (const product of asArray(state.products)) register({ name:product.name, productId:product.id, source:"产品档案" });
  for (const knowledge of asArray(state.knowledge)) {
    register({ name:knowledge.project, knowledgeId:knowledge.id, source:"知识库" });
    register({ name:knowledge.sourceTitle, knowledgeId:knowledge.id, source:"知识库" });
  }
  return [...rows.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, "zh-CN"));
};

const resolveProject = (name, dictionaryByKey) => {
  const rawKey = projectKey(name);
  const key = PROJECT_ALIASES[rawKey] || rawKey;
  if (!key) return { status:"unresolved" };
  const exact = dictionaryByKey.get(key);
  if (exact) return { status:"resolved", dictionary:exact, method:"规范名匹配" };
  const candidates = [...dictionaryByKey.entries()]
    .filter(([candidateKey]) => candidateKey.length >= 2 && (candidateKey.includes(key) || key.includes(candidateKey)))
    .map(([, item]) => item);
  if (candidates.length === 1) return { status:"resolved", dictionary:candidates[0], method:"唯一别名匹配" };
  return { status:candidates.length ? "ambiguous" : "unresolved", candidates:candidates.slice(0, 8) };
};

const buildPriceEvidenceSources = (sources = []) => asArray(sources).map((item) => ({
  ...item,
  id:cleanText(item.id),
  kind:"price_evidence_source",
  customerFacing:false,
  sourcePreviews:asArray(item.sourcePreviews)
}));

const migrateLegacyPriceRecords = (state, issues) => {
  const legacy = asArray(state.prices);
  if (!legacy.length) return false;
  const productById = new Map(asArray(state.products).map((item) => [item.id, item]));
  const archive = asArray(state.legacyPriceReferences);
  let migrated = 0;
  let unresolved = 0;
  for (const record of legacy) {
    const product = productById.get(record?.productId);
    const price = cleanText(record?.price);
    const canApply = product && !isPlaceholderPrice(price)
      && product.priceOrigin !== "人工维护";
    if (canApply) {
      Object.assign(product, {
        price,
        originalPrice:cleanText(record.originalPrice),
        priceType:cleanText(record.priceType) || "标准价",
        priceApplicableScope:cleanText(record.applicableScope),
        priceApprovalStatus:cleanText(record.approvalStatus) || "待审核",
        priceEffectiveAt:cleanText(record.effectiveAt),
        priceExpiresAt:cleanText(record.expiresAt),
        priceOrigin:"历史价格迁移",
        customerFacing:false
      });
      migrated += 1;
    }
    archive.push({
      ...record,
      legacyType:"price_record",
      migrationStatus:canApply ? "merged_into_product" : "retained_for_review",
      customerFacing:false
    });
    if (!canApply && !record?.importSource) unresolved += 1;
  }
  state.legacyPriceReferences = archive
    .filter((item, index, all) => item?.id && all.findIndex((candidate) => candidate?.id === item.id) === index)
    .slice(-500);
  // 价格从此只存在产品档案；价目图片/原文单独作为证据资料保存。
  state.prices = [];
  addIssue(issues, "产品价格", "legacy_price_unresolved", "warning", unresolved, "历史价格记录缺少可确认的产品关联，已保留在迁移归档中等待人工复核。");
  return migrated > 0 || legacy.length > 0;
};

const makeReport = ({ state, issues, startedAt }) => {
  const products = asArray(state.products);
  const physicians = asArray(state.physicians);
  const customers = asArray(state.customers);
  const tasks = asArray(state.tasks);
  const conversations = asArray(state.conversations);
  const priceEvidenceSources = asArray(state.priceEvidenceSources);
  const severe = issues.filter((item) => item.severity === "error").reduce((sum, item) => sum + item.count, 0);
  const warnings = issues.filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.count, 0);
  const score = Math.max(0, 100 - severe * 15 - warnings * 2);
  return {
    version:MANAGEMENT_DATA_QUALITY_VERSION,
    checkedAt:startedAt,
    healthScore:score,
    status:severe ? "需处理" : warnings ? "待复核" : "健康",
    summary:{
      products:products.length,
      physicians:physicians.length,
      priceEvidenceSources:priceEvidenceSources.length,
      productsWithPrice:products.filter((item) => !isPlaceholderPrice(item.price)).length,
      customers:customers.length,
      customerInterestLinks:customers.flatMap((item) => asArray(item.interests)).filter((item) => item?.projectRef?.status === "resolved").length,
      tasks:tasks.length,
      conversations:conversations.length,
    projectDictionaryEntries:asArray(state.projectDictionary).length,
      legacyPriceArchive:asArray(state.legacyPriceReferences).length,
      configuredJourneys:asArray(state.journeys).length,
      journeyAssignments:customers.flatMap((item) => asArray(item.journeys)).length,
      configuredAgents:asArray(state.agents).length,
      agentCustomerAssignments:customers.filter((item) => cleanText(item.agent)).length
    },
    issues,
    issueCount:issues.reduce((sum, item) => sum + item.count, 0)
  };
};

/**
 * Normalise management state in place and return its current quality report.
 * The function is intentionally idempotent so it can run after local edits and
 * after an authenticated acquisition snapshot is merged into the UI.
 */
export function normalizeManagementState(state, { priceEvidenceSources = [], now = new Date().toISOString() } = {}) {
  if (!state || typeof state !== "object") return { changed:false, report:null };
  const issues = [];
  let changed = false;
  const collections = ["products", "physicians", "customers", "tasks", "conversations", "journeys", "agents", "knowledge", "managementUsers", "managementRoles", "audit"];
  for (const name of collections) {
    if (!Array.isArray(state[name])) { state[name] = []; changed = true; }
  }
  if (!Array.isArray(state.priceEvidenceSources) || state.priceEvidenceSources.length !== priceEvidenceSources.length) {
    state.priceEvidenceSources = buildPriceEvidenceSources(priceEvidenceSources);
    changed = true;
  }

  const legacyMigrated = migrateLegacyPriceRecords(state, issues);
  changed = changed || legacyMigrated;
  const productIdIndex = indexBy(state.products, (item) => cleanText(item?.id));
  const physicianIdIndex = indexBy(state.physicians, (item) => cleanText(item?.id));
  const customerIdIndex = indexBy(state.customers, (item) => cleanText(item?.id));
  addIssue(issues, "产品", "duplicate_id", "error", [...productIdIndex.values()].filter((items) => items.length > 1).length, "产品编号重复，已停止自动关联对应记录。");
  addIssue(issues, "医师", "duplicate_id", "error", [...physicianIdIndex.values()].filter((items) => items.length > 1).length, "医师编号重复，需人工合并后再用于排班或转接。");
  addIssue(issues, "客户", "duplicate_id", "error", [...customerIdIndex.values()].filter((items) => items.length > 1).length, "客户编号重复，系统不会自动合并客户资料。");

  const evidenceByPath = new Map();
  for (const source of state.priceEvidenceSources) {
    for (const preview of asArray(source.sourcePreviews)) {
      const path = cleanText(preview?.path);
      if (path) evidenceByPath.set(path, source.id);
    }
  }
  const resolveEvidenceSourceId = (path) => {
    const exact = evidenceByPath.get(cleanText(path));
    if (exact) return exact;
    const normalizedPath = cleanText(path);
    // 汇总型价目资料仅预览部分图片；仍可依据其来源目录回溯到同一份证据。
    return state.priceEvidenceSources
      .filter((source) => normalizedPath.startsWith(cleanText(source.sourceCollectionPath)))
      .sort((left, right) => cleanText(right.sourceCollectionPath).length - cleanText(left.sourceCollectionPath).length)[0]?.id || "";
  };
  let priceDateErrors = 0;
  let priceEvidenceMissing = 0;
  state.products = state.products.map((item) => {
    const product = { ...item };
    const priceIsPresent = !isPlaceholderPrice(product.price);
    const evidenceId = resolveEvidenceSourceId(product.referencePriceSourcePath);
    product.priceCount = priceIsPresent ? 1 : 0;
    product.salesStatusCode = productStatusCode(product.salesStatus);
    product.reviewStatusCode = reviewStatusCode(product.approvalStatus);
    product.priceReviewStatusCode = reviewStatusCode(product.priceApprovalStatus);
    product.priceEvidenceSourceIds = unique([...(asArray(product.priceEvidenceSourceIds)), evidenceId]);
    product.customerFacing = false;
    if (product.referencePrice && !evidenceId) priceEvidenceMissing += 1;
    if (!validDate(product.priceEffectiveAt) || !validDate(product.priceExpiresAt)
      || (product.priceEffectiveAt && product.priceExpiresAt && Date.parse(product.priceExpiresAt) <= Date.parse(product.priceEffectiveAt))) priceDateErrors += 1;
    if (JSON.stringify(product) !== JSON.stringify(item)) changed = true;
    return product;
  });
  addIssue(issues, "产品价格", "invalid_effective_window", "error", priceDateErrors, "产品价格的生效日期或失效日期不符合有效期规则。");
  addIssue(issues, "产品价格", "missing_evidence", "warning", priceEvidenceMissing, "资料参考价缺少可追溯的原始价目来源，不能进入正式报价审核。");

  const dictionary = buildProjectDictionary(state);
  const dictionaryByKey = new Map(dictionary.map((item) => [projectKey(item.canonicalName), item]));
  state.projectDictionary = dictionary;
  let unresolvedInterest = 0;
  let ambiguousInterest = 0;
  state.customers = state.customers.map((item) => {
    const customer = { ...item, lifecycleStatusCode:lifecycleStatusCode(item.macroStage) };
    customer.interests = asArray(item.interests).map((interest) => {
      const resolved = resolveProject(interest?.name, dictionaryByKey);
      if (resolved.status === "unresolved") unresolvedInterest += 1;
      if (resolved.status === "ambiguous") ambiguousInterest += 1;
      const projectRef = resolved.dictionary
        ? { id:resolved.dictionary.id, name:resolved.dictionary.canonicalName, status:"resolved", method:resolved.method }
        : { status:resolved.status, candidateIds:asArray(resolved.candidates).map((candidate) => candidate.id) };
      return { ...interest, projectRef };
    });
    if (JSON.stringify(customer) !== JSON.stringify(item)) changed = true;
    return customer;
  });
  addIssue(issues, "客户项目", "unresolved_interest", "warning", unresolvedInterest, "客户兴趣未找到统一项目字典项，已保留原始描述，不参与自动运营规则。");
  addIssue(issues, "客户项目", "ambiguous_interest", "warning", ambiguousInterest, "客户兴趣对应多个项目候选，需人工选择后才可用于自动运营。");

  let unresolvedKnowledgeProject = 0;
  state.knowledge = state.knowledge.map((item) => {
    const resolved = resolveProject(item?.project || item?.sourceTitle, dictionaryByKey);
    if (resolved.status !== "resolved" && cleanText(item?.project || item?.sourceTitle)) unresolvedKnowledgeProject += 1;
    const projectRef = resolved.dictionary
      ? { id:resolved.dictionary.id, name:resolved.dictionary.canonicalName, status:"resolved", method:resolved.method }
      : { status:resolved.status, candidateIds:asArray(resolved.candidates).map((candidate) => candidate.id) };
    const knowledge = { ...item, projectRef, customerFacing:false };
    if (JSON.stringify(knowledge) !== JSON.stringify(item)) changed = true;
    return knowledge;
  });
  addIssue(issues, "知识库", "unresolved_project", "warning", unresolvedKnowledgeProject, "知识条目的项目名称无法唯一映射到项目字典，暂不用于自动项目推荐。");

  let unresolvedPhysicianProject = 0;
  state.physicians = state.physicians.map((item) => {
    const links = asArray(item.signatureProjects).map((name) => ({ name, ...resolveProject(name, dictionaryByKey) }));
    const resolvedIds = links.filter((link) => link.status === "resolved").map((link) => link.dictionary.id);
    unresolvedPhysicianProject += links.filter((link) => link.status !== "resolved").length;
    const physician = {
      ...item,
      signatureProjectRefs:links.map((link) => link.dictionary
        ? { name:link.name, projectDictionaryId:link.dictionary.id, status:"resolved", method:link.method }
        : { name:link.name, status:link.status, candidateIds:asArray(link.candidates).map((candidate) => candidate.id) }),
      signatureProjectDictionaryIds:unique(resolvedIds),
      customerFacing:false
    };
    if (JSON.stringify(physician) !== JSON.stringify(item)) changed = true;
    return physician;
  });
  addIssue(issues, "医师项目", "unresolved_specialty", "info", unresolvedPhysicianProject, "医师擅长领域尚未建立具体项目映射，不会自动生成医生推荐关系。");

  const customerIds = new Set(state.customers.map((item) => item.id));
  const orphanTasks = state.tasks.filter((item) => item.customerId && !customerIds.has(item.customerId)).length;
  const orphanConversations = state.conversations.filter((item) => item.customerId && !customerIds.has(item.customerId)).length;
  addIssue(issues, "客户关联", "orphan_task", "error", orphanTasks, "任务关联的客户不存在，已禁止其参与自动执行。");
  addIssue(issues, "客户关联", "orphan_conversation", "error", orphanConversations, "会话关联的客户不存在，需人工核对归属。");

  // 客户旅程与 AI 岗位在一期以客户档案为运行事实来源。配置中的目标完成率、
  // 版本等仍是配置数据，但“当前运行人数/服务客户数”不得继续沿用旧演示数字。
  const journeyIds = new Set(state.journeys.map((item) => cleanText(item.id)));
  const agentNames = new Set(state.agents.map((item) => cleanText(item.name)));
  const journeyRuntime = new Map();
  let orphanJourneyAssignments = 0;
  let unconfiguredAgentAssignments = 0;
  for (const customer of state.customers) {
    for (const membership of asArray(customer.journeys)) {
      const journeyId = cleanText(membership?.id);
      if (!journeyId || !journeyIds.has(journeyId)) {
        orphanJourneyAssignments += 1;
        continue;
      }
      const current = journeyRuntime.get(journeyId) || { total:0, running:0, paused:0 };
      current.total += 1;
      if (membership.status === "运行中") current.running += 1;
      if (membership.status === "暂停") current.paused += 1;
      journeyRuntime.set(journeyId, current);
    }
    if (cleanText(customer.agent) && !agentNames.has(cleanText(customer.agent))) unconfiguredAgentAssignments += 1;
  }
  state.journeys = state.journeys.map((item) => {
    const runtime = journeyRuntime.get(item.id) || { total:0, running:0, paused:0 };
    const journey = { ...item, runtimeMembers:runtime.total, runtimeRunningMembers:runtime.running, runtimePausedMembers:runtime.paused };
    if (JSON.stringify(journey) !== JSON.stringify(item)) changed = true;
    return journey;
  });
  state.agents = state.agents.map((item) => {
    const assignedCustomers = state.customers.filter((customer) => cleanText(customer.agent) === cleanText(item.name));
    const customerIdsForAgent = new Set(assignedCustomers.map((customer) => customer.id));
    const relatedConversations = state.conversations.filter((conversation) => customerIdsForAgent.has(conversation.customerId));
    const relatedOpenTasks = state.tasks.filter((task) => customerIdsForAgent.has(task.customerId) && !["已完成", "已取消"].includes(task.status));
    const agent = {
      ...item,
      runtimeActiveCustomers:assignedCustomers.length,
      runtimeConversationCount:relatedConversations.length,
      runtimeOpenTaskCount:relatedOpenTasks.length
    };
    if (JSON.stringify(agent) !== JSON.stringify(item)) changed = true;
    return agent;
  });
  addIssue(issues, "旅程", "orphan_customer_membership", "error", orphanJourneyAssignments, "客户旅程引用不存在的旅程配置，已禁止该关系参与自动执行。");
  addIssue(issues, "AI员工", "unconfigured_customer_assignment", "error", unconfiguredAgentAssignments, "客户关联的 AI 员工不存在，已禁止按该岗位自动执行。");

  const roleNames = new Set(state.managementRoles.map((item) => cleanText(item.name)));
  let invalidUserRoles = 0;
  state.managementUsers = state.managementUsers.map((item) => {
    const user = { ...item, roleId:(state.managementRoles.find((role) => role.name === item.role)?.id || "") };
    if (user.role && !roleNames.has(cleanText(user.role))) invalidUserRoles += 1;
    if (JSON.stringify(user) !== JSON.stringify(item)) changed = true;
    return user;
  });
  addIssue(issues, "组织权限", "user_role_missing", "error", invalidUserRoles, "后台用户引用了不存在的角色，已禁止以该身份执行权限判断。");

  state.meta = { ...(state.meta || {}) };
  state.meta.managementDataModelVersion = MANAGEMENT_DATA_MODEL_VERSION;
  state.meta.managementDataQualityVersion = MANAGEMENT_DATA_QUALITY_VERSION;
  const report = makeReport({ state, issues, startedAt:now });
  if (JSON.stringify(state.dataQualityReport) !== JSON.stringify(report)) {
    state.dataQualityReport = report;
    changed = true;
  }
  return { changed, report };
}
