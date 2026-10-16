import assert from "node:assert/strict";

process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_APPROVAL_MODE = "enforce";
const {
  configuredKnowledgeReleaseTenants,
  getKnowledgeAdmissionStatus, isKnowledgeRecordAdmitted, publishKnowledgeRelease,
  resetKnowledgeReleasesForTest
} = await import("../server/knowledge-release-policy.mjs");
const {
  computeApprovedKnowledgeRecordListChecksum, loadHuameiKnowledge, retrieveHuameiKnowledge
} = await import("../server/huamei-knowledge.mjs");

resetKnowledgeReleasesForTest();
assert.deepEqual(configuredKnowledgeReleaseTenants({
  HUAMEI_RELEASE_TENANT_IDS:"release-a,release-b",
  HUAMEI_CONVERSATION_RECOVERY_TENANT_IDS:"release-b,recovery-c",
  HUAMEI_DEFAULT_TENANT_ID:"default-d",
  HUAMEI_PUBLIC_TENANT_ID:"public-e"
}, [
  { caller_id:"web", tenant_ids:["client-f", "release-a"] },
  { caller_id:"wechat", tenant_ids:["client-g"] }
]), ["release-a", "release-b", "recovery-c", "default-d", "public-e", "client-f", "client-g"]);
const packageState = loadHuameiKnowledge();
const packageVersion = packageState.version;
assert.equal(getKnowledgeAdmissionStatus("release-test", packageVersion).ready, false);
assert.equal(isKnowledgeRecordAdmitted("KB-P-024", "release-test", packageVersion), false);
assert.equal(retrieveHuameiKnowledge("6月份政策有哪些资料", { audience:"public", tenantId:"release-test" }).length, 0);

assert.throws(() => publishKnowledgeRelease({
  tenant_id:"release-test", package_version:"v1", approved_record_ids:["KB-P-024"],
  reviews:{ business:{ reviewer:"业务负责人", decision:"approved" } }
}), (error) => error.code === "KNOWLEDGE_APPROVAL_INCOMPLETE");

const approvedRecordIds = ["kb_dir_66b8d7de378ce4ed", "kb_dir_a890e5160b02abb5"];
const release = publishKnowledgeRelease({
  tenant_id:"release-test",
  package_version:packageVersion,
  package_checksum:packageState.packageChecksum,
  record_list_checksum:computeApprovedKnowledgeRecordListChecksum(approvedRecordIds, { state:packageState }),
  approved_record_ids:approvedRecordIds,
  reviews:{
    business:{ reviewer:"业务负责人", decision:"approved" },
    medical:{ reviewer:"医务负责人", decision:"approved" },
    compliance:{ reviewer:"合规负责人", decision:"approved" }
  }
}, "admin-test");

assert.equal(release.status, "active");
assert.equal(getKnowledgeAdmissionStatus("release-test", packageVersion).ready, true);
assert.equal(isKnowledgeRecordAdmitted("kb_dir_66b8d7de378ce4ed", "release-test", packageVersion), true);
assert.equal(isKnowledgeRecordAdmitted("KB-P-999", "release-test", packageVersion), false);
const releasedHits = retrieveHuameiKnowledge("6月份政策有哪些资料", { audience:"public", tenantId:"release-test", limit:5 });
assert.ok(releasedHits.length >= 1);
assert.ok(releasedHits.every((item) => release.approved_record_ids.includes(item.item.record_id)));
console.log("✓ 知识包业务、医务、合规三审发布门禁与租户隔离通过");
