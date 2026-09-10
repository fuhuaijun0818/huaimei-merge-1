import assert from "node:assert/strict";
import { getKnowledgeGovernanceOverview } from "../server/knowledge-governance-overview.mjs";

const overview = getKnowledgeGovernanceOverview("huamei-shanghai");
assert.equal(overview.schema, "huamei.knowledge-governance-overview.v1");
assert.equal(overview.tenant_id, "huamei-shanghai");
assert.equal(overview.internal_catalog.total_records, 7127);
assert.equal(overview.internal_catalog.public_candidate_records, 925);
assert.equal(overview.internal_catalog.restricted_records, 6202);
assert.equal(
  overview.internal_catalog.total_records,
  overview.internal_catalog.public_candidate_records + overview.internal_catalog.restricted_records,
  "内部目录总数必须等于对客候选与隔离资料之和"
);
assert.equal(overview.controls.internal_catalog_direct_response, false);
assert.equal(overview.controls.customer_answer_source, "active_customer_release_only");
assert.deepEqual(overview.controls.direct_qa_flow, ["上传", "受控解析", "内部索引", "版本校订", "院方线下确认", "候选待评测"]);
assert.equal(overview.graph_index.engine, "bootstrap_graph");
assert.equal(overview.graph_index.document_count, 925);
assert.ok(overview.graph_index.entity_count > 0);
assert.ok(overview.graph_index.relationship_count > 0);
assert.equal(overview.graph_index.production_eligible, false);

const managementPayload = JSON.stringify(overview);
assert.doesNotMatch(
  managementPayload,
  /source_root|source_relative_path|knowledge_units_sha256|manifest_sha256|approved_record_ids/i,
  "治理概览不得向浏览器传出内部路径、发布校验和或原始记录ID"
);

console.log("✓ 知识治理概览仅返回准入、发布与图谱状态，不暴露原始内部资料");
