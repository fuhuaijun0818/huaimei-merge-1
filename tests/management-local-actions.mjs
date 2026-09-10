import assert from "node:assert/strict";
import fs from "node:fs";

const memory = new Map();
globalThis.localStorage = {
  getItem(key) { return memory.get(key) || null; },
  setItem(key, value) { memory.set(key, String(value)); },
  removeItem(key) { memory.delete(key); },
  clear() { memory.clear(); }
};

const { applyManagementDomainOverlay, store } = await import(`../src/store.js?management-local-actions=${Date.now()}`);

const migratedRoleOverlay = applyManagementDomainOverlay({
  currentRole:"医务合规审核员",
  managementRoles:[
    { id:"R-001", name:"系统管理员" },
    { id:"R-002", name:"售前顾问" },
    { id:"R-003", name:"医务合规审核员" }
  ],
  managementUsers:[
    { id:"U-legacy-admin", name:"旧管理员", role:"系统管理员" },
    { id:"U-legacy-sales", name:"旧售前", role:"售前顾问" },
    { id:"U-legacy-medical", name:"旧合规", role:"医务合规审核员" }
  ]
}, store.baseState);
assert.deepEqual(migratedRoleOverlay.managementRoles.map((item) => item.id), ["R-ADMIN", "R-PRESALES", "R-CONTENT", "R-PUBLISHER", "R-QUALITY", "R-SUPERADMIN"], "legacy hydration must use the five-role plus superadministrator catalog");
assert.equal(migratedRoleOverlay.currentRole, "系统管理员", "legacy active roles must map to the approved administrator role");
assert.equal(migratedRoleOverlay.managementUsers.find((item) => item.id === "U-legacy-admin")?.roleId, "R-ADMIN");
assert.equal(migratedRoleOverlay.managementUsers.find((item) => item.id === "U-legacy-sales")?.roleId, "R-PRESALES");
assert.equal(migratedRoleOverlay.managementUsers.find((item) => item.id === "U-legacy-medical")?.roleId, "R-PRESALES");

// Local management runtime no longer ships fictional customers. Add an
// operator-created record to validate the real write path in isolation.
store.state.customers.push({
  id:"C-test-local",
  name:"测试客户",
  mobile:"13800000000",
  owner:"测试运营",
  agent:"",
  timeline:[],
  interests:[],
  pains:[],
  itches:[],
  delights:[],
  journeys:[],
  profile:{},
  nextAction:{ title:"待制定", guardrail:"待确认" }
});
const customer = store.state.customers.find((item) => item.id === "C-test-local");
assert.ok(customer, "test fixture must create a local management customer");

const conversation = store.createConversationDraft({ customerId:customer.id, channel:"企业微信" });
assert.ok(conversation?.id, "creating a conversation must return a persisted draft");
assert.equal(conversation.status, "待人工");
assert.equal(conversation.mode, "人工");
assert.deepEqual(conversation.messages, [], "creating a draft must not send a customer message");
assert.match(conversation.lastMessage, /尚未向客户发送消息/);
assert.ok(store.customer(customer.id).timeline.some((item) => item.title.includes("会话草稿已创建")), "customer timeline must record the draft");
assert.ok(store.state.audit.some((item) => item.object === conversation.id && item.result === "未触达客户"), "audit trail must prove no customer contact occurred");
store.sendMessage(conversation.id, "已在获批渠道完成沟通，现登记结果。", "人工");
assert.ok(store.customer(customer.id).timeline.some((item) => item.title.includes("人工沟通记录已登记")), "人工录入只能登记沟通事实，不能伪装为系统外发");
assert.ok(store.state.audit.some((item) => item.action === "登记人工沟通记录" && item.object === conversation.id && item.result.includes("未触发外部发送")), "人工沟通登记必须留下未外发的审计事实");

const knowledge = store.addKnowledgeDraft({
  title:"测试知识草稿",
  project:"测试项目",
  risk:"H2",
  excerpt:"用于验证知识草稿不会直接对客发布。"
});
assert.ok(knowledge?.id, "creating knowledge must return a draft");
assert.equal(knowledge.status, "待医务与合规审核");
assert.equal(knowledge.customerFacing, false, "new knowledge must default to non-customer-facing");
assert.ok(store.state.audit.some((item) => item.object.includes(knowledge.id) && item.action === "新增知识草稿"), "knowledge creation must be audited");

const connector = store.addConnector({ name:"测试预约连接器", vendor:"测试服务商", direction:"双向" });
assert.ok(connector?.id, "creating connector metadata must return a connector");
assert.equal(connector.status, "待接入");
assert.equal(connector.telemetryAvailable, false, "an unconfigured connector must not impersonate a live integration");
assert.ok(store.state.audit.some((item) => item.object.includes(connector.id) && item.action === "新增连接器配置"), "connector creation must be audited");

assert.deepEqual(store.state.managementRoles.map((item) => item.id), ["R-ADMIN", "R-PRESALES", "R-CONTENT", "R-PUBLISHER", "R-QUALITY", "R-SUPERADMIN"], "fixed roles include the explicit superadministrator");
assert.equal(store.addManagementRole({ name:"测试角色", scope:"运营中心", permissions:["产品查看"] }), null, "phase one must fail closed when a legacy action tries to create a third role");
assert.equal(store.updateManagementRole("R-ADMIN", { name:"测试角色" }), null, "fixed phase-one roles must remain read-only");
assert.equal(store.state.managementRoles.length, 6, "role write attempts must not expand the fixed role model");

const managementUser = store.addManagementUser({ name:"测试用户", account:"test-user", department:"运营中心", roleId:"R-PRESALES", role:"售前人员" });
assert.ok(managementUser?.id, "creating a management user must return a user");
assert.equal(managementUser.status, "启用");
assert.equal(managementUser.roleId, "R-PRESALES", "user role assignments must use one of the fixed role ids");
assert.equal(managementUser.role, "售前顾问");
assert.ok(store.state.audit.some((item) => item.action === "新增后台用户" && item.object.includes("test-user")), "management user creation must be audited");

const updatedUser = store.updateManagementUser(managementUser.id, { name:"测试用户", account:"test-user", department:"运营中心", roleId:"R-NOT-ALLOWED", role:"测试角色", status:"停用" });
assert.equal(updatedUser?.status, "停用", "operators must be able to maintain user enablement status");
assert.equal(updatedUser?.roleId, "R-PRESALES", "invalid role payloads must never create or assign a third role");
assert.ok(store.state.audit.some((item) => item.action === "更新后台用户" && item.object.includes("test-user")), "user changes must be audited");

const migratedMedicalUser = store.addManagementUser({ name:"历史合规账号", account:"legacy-medical", department:"医务与合规", role:"医务合规审核员" });
assert.equal(migratedMedicalUser.roleId, "R-PRESALES", "legacy medical/compliance users must migrate to the administrator role");

const configuration = store.addConfigurationRecord({
  kind:"journey_template",
  name:"测试旅程模板",
  stage:"售前",
  status:"草稿",
  nodes:["开始条件", "人工确认", "结束"]
});
assert.ok(configuration?.id, "creating an operator configuration must return a record");
assert.equal(configuration.kind, "journey_template");
assert.ok(store.state.audit.some((item) => item.action === "新增运营配置" && item.object.includes("测试旅程模板")), "configuration creation must be audited");
const updatedConfiguration = store.updateConfigurationRecord(configuration.id, { ...configuration, status:"启用", name:"测试旅程模板（已更新）" });
assert.equal(updatedConfiguration?.status, "启用", "operators must be able to update configuration status");
assert.equal(updatedConfiguration?.name, "测试旅程模板（已更新）");
assert.ok(store.state.audit.some((item) => item.action === "更新运营配置" && item.object.includes("测试旅程模板（已更新）")), "configuration changes must be audited");

store.upsertAcquisitionSnapshot({
  customers:[
    { id:"C-acquisition-test", origin:"acquisition_advisor", dataClassification:"test", name:"留资测试客户" },
    { id:"C-acquisition-operational", origin:"acquisition_advisor", dataClassification:"production", name:"真实咨询客户" }
  ],
  conversations:[
    { id:"V-acquisition-test", customerId:"C-acquisition-test" },
    { id:"V-acquisition-operational", customerId:"C-acquisition-operational" }
  ],
  tasks:[
    { id:"T-acquisition-test", customerId:"C-acquisition-test" },
    { id:"T-acquisition-operational", customerId:"C-acquisition-operational" }
  ]
});
assert.equal(store.state.customers.some((item) => item.id === "C-acquisition-test"), false, "明确标记的测试留资不得进入运营客户列表");
assert.equal(store.state.conversations.some((item) => item.id === "V-acquisition-test"), false, "测试留资关联会话必须同步隔离");
assert.equal(store.state.tasks.some((item) => item.id === "T-acquisition-test"), false, "测试留资关联任务必须同步隔离");
assert.equal(store.state.customers.some((item) => item.id === "C-acquisition-operational"), true, "生产留资必须继续进入运营客户列表");

const product = store.addProduct({ name:"测试产品", department:"皮肤美容科", category:"测试分类" });
assert.ok(product?.id, "creating a product must return a product");
assert.equal(product.status, "草稿", "a new product must not be immediately customer-facing");
assert.equal(product.salesStatus, "待完善", "new products must expose an operator-maintainable sales status");
assert.equal(product.price, "", "new products may be created before a price is maintained");
const updatedProduct = store.updateProduct(product.id, {
  salesStatus:"在售", owner:"测试运营", highlights:"支持真人维护项目亮点",
  priceType:"会员价", price:"¥5,980", originalPrice:"¥6,980", priceApplicableScope:"会员客户", priceApprovalStatus:"待审核"
});
assert.equal(updatedProduct?.salesStatus, "在售", "operators must be able to maintain product fields");
assert.equal(updatedProduct?.owner, "测试运营");
assert.equal(updatedProduct?.price, "¥5,980", "operators must be able to maintain a product price directly");
assert.equal(updatedProduct?.priceType, "会员价");
assert.equal(updatedProduct?.customerFacing, false, "editing price fields must never directly release it to customers");
assert.ok(store.state.audit.some((item) => item.action === "编辑产品" && item.object.includes("测试产品")), "product and price-field maintenance must be audited");

const appSource = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const subpagesSource = fs.readFileSync(new URL("../src/subpages.js", import.meta.url), "utf8");
assert.doesNotMatch(subpagesSource, /\[\["overview", "产品管理"\], \["prices", "价格管理"\]\]/, "pricing must not render as an independent catalog tab");
assert.doesNotMatch(subpagesSource, /function catalogPrices\(/, "pricing page renderer must be removed when price is a product field");
assert.match(subpagesSource, /常用话术库/, "sales staff need a dedicated phrase-library entry");
assert.match(subpagesSource, /会话窗口可插入/, "enabled phrases must be marked as insertable in the conversation workspace");
assert.match(subpagesSource, /一期角色说明（只读）/, "role management must describe the fixed phase-one model");
assert.doesNotMatch(subpagesSource, /data-action="new-management-role"/, "the role page must not render a create-role action");
assert.doesNotMatch(subpagesSource, /data-action="edit-management-role"/, "the role page must not render role edit actions");
const declaredActions = [...new Set([...appSource.matchAll(/data-action="([A-Za-z][A-Za-z0-9-]*)"/g)].map((match) => match[1]))];
const handledActions = [
  ...[...appSource.matchAll(/case "([^"]+)"/g)].map((match) => match[1]),
  ...[...appSource.matchAll(/if \(action === "([^"]+)"\)/g)].map((match) => match[1])
];
const missingActionHandlers = declaredActions.filter((action) => !handledActions.includes(action));
const duplicatedActionHandlers = handledActions.filter((action, index) => handledActions.indexOf(action) !== index);
assert.deepEqual(missingActionHandlers, [], "every rendered management action needs an explicit handler");
assert.deepEqual(duplicatedActionHandlers, [], "management action handlers must not contain unreachable duplicate cases");
assert.doesNotMatch(appSource, /操作已记录（演示模式）/, "unimplemented actions must never report fake success");
assert.match(appSource, /id="knowledge-intake-search"/, "资料库页面必须提供后端搜索入口");
assert.match(appSource, /id="knowledge-intake-status"/, "资料库页面必须提供状态筛选入口");
assert.match(appSource, /id="knowledge-intake-content-type"/, "资料库页面必须提供内容类型筛选入口");
assert.match(appSource, /id="knowledge-intake-public-scope"/, "资料库页面必须提供公开范围筛选入口");
assert.match(appSource, /版本变更/, "资料维护详情必须显示版本变更摘要");

console.log("✓ 管理端会话草稿、知识草稿、资料筛选与连接器配置闭环，以及页面动作覆盖通过");
