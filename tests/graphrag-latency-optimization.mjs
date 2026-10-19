import assert from "node:assert/strict";
import {
  buildGraphRagQuery,
  graphRagEvidenceOnlyEnabled,
  graphRagParamsForIntent
} from "../server/agent-runtime.mjs";
import { canonicalGraphRagCacheQuery } from "../server/graphrag-client.mjs";

assert.equal(graphRagEvidenceOnlyEnabled({}), true, "生产默认必须使用证据模式");
assert.equal(graphRagEvidenceOnlyEnabled({ HUAMEI_GRAPHRAG_EVIDENCE_ONLY:"false" }), false);
assert.equal(graphRagEvidenceOnlyEnabled({ HUAMEI_GRAPHRAG_EVIDENCE_ONLY:"TRUE" }), true);

assert.deepEqual(
  graphRagParamsForIntent("conversation_followup", {
    HUAMEI_GRAPHRAG_TUNING_JSON:JSON.stringify({
      default:{ top_k:6, top_k_entities:10, top_k_relationships:10 },
      conversation_followup:{ top_k:3, top_k_entities:5, top_k_relationships:10 }
    })
  }),
  { topK:3, topKEntities:5, topKRelationships:10, maxContextTokens:undefined }
);

assert.equal(
  canonicalGraphRagCacheQuery("热玛吉 多少钱"),
  canonicalGraphRagCacheQuery("价格 热玛吉"),
  "价格同义表达和词序差异必须共享缓存键"
);

const policy = {
  output:{
    structured_data:{
      intent:"policy_verification",
      intent_analysis:{
        entities:{
          projects:[], doctors:[], concerns:[], quoted_terms:[], body_parts:[]
        }
      }
    },
    citations:[
      { source_relative_path:"6月份政策/皮肤套餐" },
      { source_relative_path:"6月份政策/皮肤套餐/皮肤套餐-01.jpg" }
    ]
  }
};
const policyQuery = buildGraphRagQuery("6月份皮肤套餐政策", policy);
assert.match(policyQuery, /6月份政策/);
assert.match(policyQuery, /皮肤套餐/);
assert.match(policyQuery, /套餐/);

console.log("✓ 证据模式默认值、按意图参数、缓存规范化与政策查询锚点通过");
