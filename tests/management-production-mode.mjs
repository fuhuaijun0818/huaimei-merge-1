import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [indexHtml, gatewaySource, appSource, runtimeSource] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/management-runtime.js", import.meta.url), "utf8")
]);

assert.ok(
  indexHtml.indexOf("./runtime-config.js") < indexHtml.indexOf("./src/app.js"),
  "server-owned runtime config must load before the management application"
);
assert.match(gatewaySource, /delivery_mode:productionRuntime \? "handover_only" : "local_server"/);
assert.match(gatewaySource, /demo_mutations_enabled:false/);
assert.match(gatewaySource, /management_domain_enabled:!productionRuntime/);
assert.match(gatewaySource, /knowledge_governance_enabled:true/);
assert.match(gatewaySource, /knowledge_intake_enabled:true/);
assert.match(gatewaySource, /Cache-Control":"no-store"/);

assert.match(runtimeSource, /\["demo", "local_server"\]\.includes\(rawRuntime\.delivery_mode\)/);
assert.match(runtimeSource, /rawRuntime\.demo_mutations_enabled === true/);
assert.match(runtimeSource, /rawRuntime\.management_domain_enabled === true/);
assert.match(runtimeSource, /rawRuntime\.knowledge_governance_enabled === true/);
assert.match(runtimeSource, /rawRuntime\.knowledge_intake_enabled === true/);
assert.match(appSource, /productionKnowledgeGovernancePage/);
assert.match(appSource, /knowledgeIntakePanel/);
assert.match(appSource, /knowledge-intake-form/);
assert.match(appSource, /handoverOnlyMode && route !== "workbench"/);
assert.match(appSource, /handoverOnlyMode && !realManagementActions\.has\(action\)/);
assert.match(appSource, /生产模式未执行任何变更/);
assert.match(appSource, /if \(!handoverOnlyMode\) \{\s*syncAcquisitionCustomers\(\);\s*syncAcquisitionChannels\(\);\s*\}/, "仅本地管理模式才可同步客户与 IM 通道状态");

const loadRuntime = async (runtimeValue, caseName) => {
  if (runtimeValue === undefined) delete globalThis.window;
  else globalThis.window = { __HUAMEI_MANAGEMENT_RUNTIME__:runtimeValue };
  return import(`../src/management-runtime.js?production-mode-test=${caseName}-${Date.now()}`);
};

const missing = await loadRuntime(undefined, "missing");
assert.equal(missing.handoverOnlyMode, true, "missing config must fail closed");
assert.equal(missing.managementRuntime.demoMutationsEnabled, false);
assert.equal(missing.knowledgeGovernanceEnabled, false, "missing config must not expose the governance page");

const malformed = await loadRuntime({ delivery_mode:"demo", demo_mutations_enabled:true }, "malformed");
assert.equal(malformed.handoverOnlyMode, true, "unversioned config must fail closed");
assert.equal(malformed.managementRuntime.demoMutationsEnabled, false);
assert.equal(malformed.knowledgeGovernanceEnabled, false);

const demo = await loadRuntime({
  schema:"huamei.management-runtime.v1",
  delivery_mode:"demo",
  demo_mutations_enabled:true
}, "demo");
assert.equal(demo.handoverOnlyMode, false);
assert.equal(demo.managementRuntime.demoMutationsEnabled, true);
assert.equal(demo.knowledgeGovernanceEnabled, false);

const localServer = await loadRuntime({
  schema:"huamei.management-runtime.v1",
  delivery_mode:"local_server",
  demo_mutations_enabled:false,
  management_domain_enabled:true
}, "local-server");
assert.equal(localServer.handoverOnlyMode, false, "本地服务模式必须开放真实本地管理功能");
assert.equal(localServer.managementRuntime.demoMutationsEnabled, false);
assert.equal(localServer.managementDomainEnabled, true);

const production = await loadRuntime({
  schema:"huamei.management-runtime.v1",
  delivery_mode:"handover_only",
  demo_mutations_enabled:false,
  knowledge_governance_enabled:true
}, "production");
assert.equal(production.handoverOnlyMode, true);
assert.equal(production.managementRuntime.demoMutationsEnabled, false);
assert.equal(production.knowledgeGovernanceEnabled, true, "production may expose the read-only governance page");
assert.equal(production.knowledgeIntakeEnabled, false, "capabilities absent from runtime config must remain closed");
for (const action of ["claim-handover", "reveal-contact", "complete-handover", "refresh-handovers", "refresh-knowledge-governance"]) {
  assert.equal(production.realManagementActions.has(action), true, `production must allow real action ${action}`);
}
assert.equal(production.realManagementActions.has("new-customer"), false, "demo mutations must remain blocked");

const productionWithIntake = await loadRuntime({
  schema:"huamei.management-runtime.v1",
  delivery_mode:"handover_only",
  demo_mutations_enabled:false,
  knowledge_governance_enabled:true,
  knowledge_intake_enabled:true
}, "production-intake");
assert.equal(productionWithIntake.knowledgeIntakeEnabled, true);
for (const action of ["refresh-knowledge-intake", "new-knowledge-intake"]) {
  assert.equal(productionWithIntake.realManagementActions.has(action), true, `production must allow server-backed action ${action}`);
}

delete globalThis.window;
console.log("management production-mode tests passed");
