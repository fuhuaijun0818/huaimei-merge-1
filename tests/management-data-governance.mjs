import assert from "node:assert/strict";
import { initialState } from "../src/data.js";
import { MANAGEMENT_DATA_MODEL_VERSION, normalizeManagementState } from "../src/management-data-governance.js";

const state = JSON.parse(JSON.stringify(initialState));
const { report } = normalizeManagementState(state, {
  priceEvidenceSources:initialState.priceEvidenceSources,
  now:"2026-08-31T09:00:00.000Z"
});

assert.equal(state.meta.managementDataModelVersion, MANAGEMENT_DATA_MODEL_VERSION);
assert.equal(state.prices, undefined, "new management state must not re-create a standalone price table");
assert.equal(state.priceEvidenceSources.length, 42, "all source price groups must remain traceable as evidence documents");
assert.equal(state.products.filter((item) => item.price).length, 45, "only directly matched price references may populate product price fields");
assert.ok(state.products.filter((item) => item.referencePrice).every((item) => item.priceEvidenceSourceIds.length === 1), "every derived price must link back to exactly one evidence source");
assert.ok(state.products.every((item) => item.priceCount === (item.price ? 1 : 0)), "price count must follow the single product-price model");
assert.ok(state.tasks.every((item) => state.customers.some((customer) => customer.id === item.customerId)), "tasks must use a valid customer primary key");
assert.ok(state.conversations.every((item) => state.customers.some((customer) => customer.id === item.customerId)), "conversations must use a valid customer primary key");
assert.ok(state.customers.flatMap((item) => item.journeys || []).every((membership) => state.journeys.some((journey) => journey.id === membership.id)), "every customer journey membership must point to a configured journey");
assert.ok(state.customers.filter((item) => item.agent).every((customer) => state.agents.some((agent) => agent.name === customer.agent)), "every customer AI assignment must point to a configured AI role");
assert.equal(state.journeys.find((item) => item.id === "J-06")?.runtimeMembers, 1, "runtime journey counts must be derived from customer memberships rather than legacy demo totals");
assert.equal(state.agents.find((item) => item.name === "AI邀约专员·小美")?.runtimeActiveCustomers, 2, "runtime AI customer counts must be derived from the customer owner relationship");
assert.ok(state.managementUsers.every((item) => item.roleId && state.managementRoles.some((role) => role.id === item.roleId)), "management users must map to an existing role");
assert.equal(state.customers.find((item) => item.name === "林知夏")?.interests.find((item) => item.name === "热玛吉")?.projectRef?.status, "resolved", "exact customer interests should use the shared project dictionary");
assert.ok(state.dataQualityReport === report && report.summary.projectDictionaryEntries > 0, "data quality report must be persisted with the normalized state");
assert.equal(report.issues.filter((item) => item.severity === "error").length, 0, "initial local management data should have no blocking primary-key or effective-date errors");

const legacyState = JSON.parse(JSON.stringify(initialState));
legacyState.prices = [{
  id:"PR-LEGACY-1", productId:"KB-P-134", product:"瑞可丽豆仙优", price:"¥2,680", originalPrice:"¥2,980",
  priceType:"会员价", applicableScope:"会员客户", approvalStatus:"待审核", effectiveAt:"2026-09-01", expiresAt:"2026-09-30"
}];
normalizeManagementState(legacyState, { priceEvidenceSources:initialState.priceEvidenceSources, now:"2026-08-31T09:00:00.000Z" });
assert.equal(legacyState.prices.length, 0, "legacy prices must be retired after migration");
assert.equal(legacyState.products.find((item) => item.id === "KB-P-134")?.price, "¥2,680", "a legacy price with a confirmed product key may be merged into the product record");
assert.ok(legacyState.legacyPriceReferences.some((item) => item.id === "PR-LEGACY-1" && item.migrationStatus === "merged_into_product"), "the original legacy record must remain auditable after migration");

console.log("✓ 后台数据治理：产品价格单一口径、价目证据追溯、客户关系、项目字典和权限关系校验通过");
