import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHuameiKnowledgeStatus } from "./huamei-knowledge.mjs";
import { listKnowledgeReleases } from "./knowledge-release-policy.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const indexRoot = join(projectRoot, "graphrag-service", "data", "indexes");

const readJsonIfPresent = (path) => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
};

const graphIndexSummary = () => {
  const pointer = readJsonIfPresent(join(indexRoot, "current.json"));
  const version = String(pointer?.version || "").trim();
  const manifest = version ? readJsonIfPresent(join(indexRoot, version, "manifest.json")) : null;
  if (!manifest) return {
    status:"not_built",
    version:null,
    engine:null,
    document_count:0,
    entity_count:0,
    relationship_count:0,
    published_at:pointer?.published_at || null,
    production_eligible:false
  };
  const official = String(manifest.engine || "") === "official_graphrag_3_1_1";
  return {
    status:official ? "official_ready" : "bootstrap_only",
    version:String(manifest.version || version),
    engine:String(manifest.engine || "unknown"),
    document_count:Number(manifest.document_count || 0),
    entity_count:Number(manifest.entity_count || 0),
    relationship_count:Number(manifest.relationship_count || 0),
    published_at:pointer?.published_at || manifest.built_at || null,
    production_eligible:official && manifest.production_eligible === true
  };
};

const releaseSummary = (release) => ({
  id:String(release?.id || ""),
  status:String(release?.status || "draft"),
  package_version:release?.package_version || null,
  approved_record_count:Number(release?.approved_record_count || release?.approved_record_ids?.length || 0),
  effective_at:release?.effective_at || null,
  activated_at:release?.activated_at || null,
  index_version:release?.index_version || release?.manifest?.index_version || null,
  review_status:{
    business:release?.reviews?.business?.decision || null,
    medical:release?.reviews?.medical?.decision || null,
    compliance:release?.reviews?.compliance?.decision || null
  }
});

/**
 * Management-safe overview. It intentionally returns only counts, lifecycle
 * state and GraphRAG manifest metadata—never raw knowledge, source paths,
 * customer-derived aggregates or checksums that can be replayed as a release.
 */
export function getKnowledgeGovernanceOverview(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  const knowledge = getHuameiKnowledgeStatus(tenant);
  const totalRecords = Number(knowledge.total_records || 0);
  const publicCandidates = Number(knowledge.public_candidate_records || 0);
  const restrictedRecords = Math.max(0, totalRecords - publicCandidates);
  const admission = knowledge.internal_catalog_admission;
  const runtimeIndex = knowledge.runtime_knowledge_index || {};
  const active = knowledge.admission?.active_release || null;
  const releases = listKnowledgeReleases(tenant)
    .map(releaseSummary)
    .sort((left, right) => String(right.activated_at || right.effective_at || "").localeCompare(String(left.activated_at || left.effective_at || "")))
    .slice(0, 10);

  return {
    schema:"huamei.knowledge-governance-overview.v1",
    tenant_id:tenant,
    retrieved_at:new Date().toISOString(),
    internal_catalog:{
      loaded:knowledge.loaded === true,
      total_records:totalRecords,
      admitted:admission?.status === "approved_for_internal_catalog",
      approved_count:Number(admission?.approved_count || 0),
      approved_at:admission?.approved_at || null,
      public_candidate_records:publicCandidates,
      restricted_records:restrictedRecords
    },
    customer_release:{
      mode:knowledge.admission?.mode || "preview",
      ready:knowledge.admission?.ready === true,
      public_retrievable_records:Number(knowledge.public_retrievable_records || 0),
      active_release:active ? releaseSummary(active) : null,
      preview_warning:knowledge.admission?.preview_warning || null
    },
    direct_qa_index:{
      mode:runtimeIndex.index_mode || "local_vector",
      embedding_model:runtimeIndex.embedding_model || null,
      documents:Number(runtimeIndex.documents || 0),
      chunks:Number(runtimeIndex.chunks || 0),
      public_chunks:Number(runtimeIndex.public_chunks || 0),
      revision:Number(runtimeIndex.revision || 0)
    },
    graph_index:graphIndexSummary(),
    recent_releases:releases,
    controls:{
      customer_answer_source:"active_customer_release_only",
      internal_catalog_direct_response:false,
      required_before_graph_activation:["正式图谱索引绑定", "图谱评测", "发布人激活"],
      direct_qa_flow:["上传", "受控解析", "内部索引", "版本校订", "院方线下确认", "候选待评测"]
    }
  };
}
