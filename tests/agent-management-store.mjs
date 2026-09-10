import assert from "node:assert/strict";
import { initialState } from "../src/data.js";

const values = new Map();
globalThis.localStorage = {
  getItem:(key) => values.get(key) || null,
  setItem:(key, value) => values.set(key, String(value)),
  removeItem:(key) => values.delete(key),
  clear:() => values.clear()
};

const { applyManagementDomainOverlay, isSystemMandatoryAgent, store } = await import(`../src/store.js?agent-management-store=${Date.now()}`);

const mandatorySeed = initialState.agents.find((item) => item.id === "A-06");
assert.equal(mandatorySeed?.systemManaged, true, "system guard seed must be marked as system managed");
assert.equal(mandatorySeed?.allowDisable, false, "system guard seed must not be disableable");
assert.equal(mandatorySeed?.allowDelete, false, "system guard seed must not be deletable");
assert.equal(mandatorySeed?.evaluationGate?.minimumScore, 98, "system guard must carry an explicit evaluation threshold");

const events = [];
store.addEventListener("change", (event) => events.push(event.detail?.source));

const created = store.addAgent({
  name:"AI面诊前咨询助手",
  role:"项目科普、需求澄清与面诊预约协同",
  responsibilities:["项目科普", "需求澄清", "预约信息收集"],
  skills:["意图识别", "项目介绍", "预约字段采集"],
  forbidden:["医疗诊断", "个体适用性判断", "效果承诺"],
  knowledge:"售前项目与预约知识 v1.0",
  knowledgeScope:{
    labels:["已发布项目知识", "预约流程"],
    knowledgeIds:["K-100", "K-101"],
    projectScopes:["皮肤美容", "胸部整形"],
    releaseRequirement:"仅可读取已准入且在有效期内的知识"
  },
  owner:"在线咨询组负责人",
  ownerId:"HM-PS-OWNER-001",
  status:"运行中",
  levelCode:"L2_CONTROLLED",
  version:"v1.0",
  evaluationGate:{
    suite:"一期固定回归集",
    minimumScore:95,
    lastScore:97,
    evaluatedAt:"2026-09-07T10:00:00.000Z",
    evidenceRef:"EVAL-20260907-001"
  }
});

assert.match(created.id, /^A-\d+$/, "new agents need a generated durable id");
assert.equal(created.status, "运行中", "a complete and evaluated record may enter running status");
assert.equal(created.levelCode, "L2_CONTROLLED");
assert.deepEqual(created.responsibilities, ["项目科普", "需求澄清", "预约信息收集"]);
assert.deepEqual(created.skills, ["意图识别", "项目介绍", "预约字段采集"]);
assert.deepEqual(created.forbidden, ["医疗诊断", "个体适用性判断", "效果承诺"]);
assert.deepEqual(created.disabledCapabilities, created.forbidden, "disabled capability aliases must stay in sync");
assert.deepEqual(created.knowledgeScope.knowledgeIds, ["K-100", "K-101"]);
assert.equal(created.knowledgeScope.projectScopes[1], "胸部整形");
assert.equal(created.owner, "在线咨询组负责人");
assert.equal(created.version, "v1.0");
assert.equal(created.evaluationGate.status, "通过");
assert.equal(created.evaluationThreshold, 95);
assert.ok(store.state.audit.some((item) => item.action === "新增智能体" && item.object.includes(created.id)), "create must be auditable");
assert.ok(events.includes("agent-add"), "create must use the store persistence boundary");

const unsafe = store.addAgent({
  name:"\"><img src=x onerror=alert(1)>",
  role:"临时测试",
  status:"运行中",
  systemManaged:true,
  mandatory:true,
  levelCode:"L4_MANDATORY"
});
assert.equal(unsafe.systemManaged, false, "new agents cannot self-declare system ownership");
assert.equal(unsafe.mandatory, false, "new agents cannot self-declare mandatory protection");
assert.equal(unsafe.levelCode, "L1_APPROVAL", "ordinary agents cannot self-promote to L4");
assert.equal(unsafe.status, "草稿", "incomplete or unevaluated records must fail closed to draft");
assert.doesNotMatch(unsafe.name, /[<>"]/u, "operator input must remain safe for legacy display sinks");

const updated = store.updateAgent(created.id, {
  responsibilities:["项目科普", "多轮需求澄清", "面诊预约协同"],
  skills:["意图识别", "情绪识别", "预约字段采集"],
  forbidden:["医疗诊断", "个体适用性判断", "价格承诺"],
  knowledgeScope:{
    labels:["已发布项目知识", "预约流程", "面诊须知"],
    knowledgeIds:["K-100", "K-101", "K-102"],
    projectScopes:["皮肤美容", "胸部整形", "鼻部整形"]
  },
  version:"v1.1",
  evaluationGate:{ minimumScore:96, lastScore:98, evidenceRef:"EVAL-20260907-002" },
  status:"运行中"
});
assert.equal(updated?.version, "v1.1", "version maintenance must persist");
assert.equal(updated?.evaluationGate.minimumScore, 96, "evaluation threshold updates must persist");
assert.equal(updated?.evaluationGate.lastScore, 98, "evaluation score updates must persist");
assert.equal(updated?.status, "运行中");
assert.ok(updated?.skills.includes("情绪识别"));
assert.ok(updated?.forbidden.includes("价格承诺"));
assert.ok(store.state.audit.some((item) => item.action === "更新智能体" && item.object.includes(created.id)), "update must be auditable");
assert.ok(events.includes("agent-update"), "update must use the store persistence boundary");

const overlay = store.managementOverlay();
const restored = applyManagementDomainOverlay(overlay, store.baseState);
const restoredAgent = restored.agents.find((item) => item.id === created.id);
assert.equal(restoredAgent?.version, "v1.1", "agent configuration must survive the management-domain persistence overlay");
assert.deepEqual(restoredAgent?.knowledgeScope.knowledgeIds, ["K-100", "K-101", "K-102"]);
assert.equal(restoredAgent?.evaluationGate.minimumScore, 96);

store.state.customers.push({ id:"C-AGENT-ASSIGNED", agent:created.name });
assert.equal(store.deleteAgent(created.id), false, "agents with assigned customers must be reassigned before deletion");
assert.ok(store.state.agents.some((item) => item.id === created.id));
assert.ok(store.state.audit.some((item) => item.action === "拒绝删除智能体" && item.object.includes(created.id)), "refused deletion must be auditable");
store.state.customers = store.state.customers.filter((item) => item.id !== "C-AGENT-ASSIGNED");
assert.equal(store.deleteAgent(created.id), true, "an unassigned ordinary agent may be deleted");
assert.equal(store.state.agents.some((item) => item.id === created.id), false);
assert.ok(store.state.audit.some((item) => item.action === "删除智能体" && item.object.includes(created.id)), "successful deletion must be auditable");
assert.ok(events.includes("agent-delete"), "delete must use the store persistence boundary");

// Simulate a server-hydrated legacy mandatory guard. Its historic status is
// intentionally set to disabled: hydration must restore the hard invariant.
store.hydrateManagementOverlay({
  overlay:{
    agents:[{
      id:"A-06", name:"合规守门员", role:"内容与动作风险控制", status:"已停用",
      levelCode:"L4_MANDATORY", skills:["风险拦截"], forbidden:["关闭核心门禁"],
      knowledge:"合规规则 v4.1", owner:"医务与合规负责人", version:"v4.1",
      evaluationGate:{ minimumScore:98, lastScore:99 }
    }]
  }
});
const mandatory = store.state.agents.find((item) => item.id === "A-06");
assert.ok(isSystemMandatoryAgent(mandatory));
assert.equal(mandatory.status, "运行中", "mandatory guards must be restored to running on hydration");
assert.equal(mandatory.allowDisable, false);
assert.equal(mandatory.allowDelete, false);

const mandatoryUpdate = store.updateAgent("A-06", { status:"已停用", version:"v4.2" });
assert.equal(mandatoryUpdate?.status, "运行中", "update cannot turn off a mandatory guard");
assert.equal(mandatoryUpdate?.version, "v4.2", "non-lifecycle settings of a guard can remain maintainable");
assert.equal(store.toggleAgent("A-06"), null, "toggle must fail closed for mandatory guards");
assert.equal(store.deleteAgent("A-06"), false, "mandatory guards must not be deletable");
assert.ok(store.state.audit.some((item) => item.action === "拒绝停用系统智能体"), "guard disable attempts must be audited");
assert.ok(store.state.audit.some((item) => item.action === "拒绝删除系统智能体"), "guard deletion attempts must be audited");

console.log("✓ 智能体运营档案、评测门槛、持久化审计与系统合规守门员保护通过");
