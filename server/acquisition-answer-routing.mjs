export const ACQUISITION_ANSWER_ROUTING_VERSION = "1.2.0";

const ENTERPRISE_FACT_PATTERN = /(?:上海华美|华美(?:医院)?|本院|你们(?:医院|这里)|医生|院长|主任|专家|排班|出诊|可约|预约|价格|报价|多少钱|收费|活动|优惠|会员|地址|电话|营业时间|曼托|傲诺拉|特贝茨|璀璨|水滴形|水滴型|微绒|光面|型号|品牌)/i;
const GENERIC_EDUCATION_PATTERN = /(?:原理|是什么|区别|对比|比较|恢复|术后|注意|流程|一般|常见|多久|怎么选)/;
const GENERIC_PROJECT_PATTERN = /(?:丰胸|隆胸|胸部整形|假体|自体脂肪|鼻整形|双眼皮|线雕|拉皮|热玛吉|光子嫩肤|水光|吸脂|脂肪填充|皮肤美容)/;
const RISK_OR_RESTRICTED_INTENTS = new Set([
  "medical_emergency", "medical_safety", "medical_suitability", "privacy_or_complaint",
  "human_handover_request", "security_or_compliance", "case_request_restricted"
]);
const ENTERPRISE_INTENTS = new Set([
  "product_attribute_verification", "doctor_profile", "doctor_discovery_by_project", "doctor_comparison",
  "doctor_project_verification", "doctor_schedule_verification", "price_verification", "policy_verification", "directory_discovery",
  "product_catalog_detail", "appointment_query", "appointment_request", "service_information"
]);
const STRUCTURED_FACT_INTENTS = new Set([
  "price_verification", "doctor_schedule_verification",
  "appointment_query", "appointment_request"
]);
const KNOWLEDGE_FRESHNESS_INTENTS = new Set(["policy_verification"]);
const GRAPH_KNOWLEDGE_INTENTS = new Set([
  "product_attribute_verification", "doctor_profile", "doctor_discovery_by_project", "doctor_comparison",
  "doctor_project_verification", "directory_discovery", "product_catalog_detail", "policy_verification"
]);
const GRAPH_PROJECT_INTENTS = new Set(["project_explanation", "project_comparison", "conversation_followup"]);
const GRAPH_RELATION_INTENTS = new Set(["doctor_comparison"]);

const requiresRelationshipReasoning = ({ message = "", intent = "", analysis = {} } = {}) => {
  if (GRAPH_RELATION_INTENTS.has(intent)) return true;
  const text = String(message);
  const entities = analysis?.entities || {};
  // 关系推理始终走 GraphRAG；稳定知识意图在 enterprisePlan 中按意图集合决定。
  return (entities.doctors?.length >= 2 && /(?:对比|区别|怎么选|关系|关联)/.test(text))
    || (entities.projects?.length >= 2 && /(?:关系|关联|交叉|同时)/.test(text))
    || /(?:哪些医生|哪几位医生).{0,16}(?:都|同时|也).{0,16}(?:做|擅长|覆盖)/.test(text);
};

const freshnessFor = (intent, text) => {
  const structuredDynamic = STRUCTURED_FACT_INTENTS.has(intent);
  const knowledgeDynamic = KNOWLEDGE_FRESHNESS_INTENTS.has(intent);
  const dynamic = structuredDynamic || knowledgeDynamic
    || /(?:今天|本周|现在|当前|最新|实时|名额|剩余|有效期)/.test(text);
  return {
    required:dynamic,
    source_of_truth:structuredDynamic ? "structured_business_data" : "approved_knowledge_release",
    verification_required:dynamic,
    verified_at:null,
    reason:structuredDynamic ? "time_sensitive_business_fact"
      : knowledgeDynamic ? "time_sensitive_knowledge_fact"
        : dynamic ? "time_sensitive_verification_required" : "versioned_knowledge_fact"
  };
};

const enterprisePlan = ({ message, intent, analysis }) => {
  const text = String(message);
  const relationship = requiresRelationshipReasoning({ message:text, intent, analysis });
  const structured = STRUCTURED_FACT_INTENTS.has(intent);
  const projectKnowledge = GRAPH_PROJECT_INTENTS.has(intent)
    && ((analysis?.entities?.projects || []).length > 0 || GENERIC_PROJECT_PATTERN.test(text));
  const graphKnowledge = GRAPH_KNOWLEDGE_INTENTS.has(intent) || projectKnowledge || relationship;
  const strategy = structured ? "structured_business_data" : graphKnowledge ? "graph_rag" : "rag_metadata";
  return {
    // 保留既有对外 route 值，避免已接入客户端因字段重命名而失效；
    // retrieval_strategy 才是执行层的精确路由，不再默认走 GraphRAG。
    route:"enterprise_knowledge_graph",
    retrieval_strategy:strategy,
    tool_execution: intent === "appointment_request" ? "confirmation_required" : "not_requested",
    model_generation_mode:"grounded_copy_only",
    freshness:freshnessFor(intent, text),
    reason:structured ? "time_sensitive_structured_business_fact"
      : graphKnowledge ? "stable_knowledge_requires_graph_evidence"
        : "enterprise_fact_with_versioned_rag_evidence",
    version:ACQUISITION_ANSWER_ROUTING_VERSION
  };
};

const topicFor = (message, analysis = {}) => {
  const text = String(message).trim();
  const project = analysis?.entities?.projects?.[0] || (
    /(?:丰胸|隆胸|胸部)/.test(text) ? "胸部整形" :
    /(?:鼻|隆鼻)/.test(text) ? "鼻部整形" :
    /(?:热玛吉)/.test(text) ? "热玛吉" :
    /(?:线雕)/.test(text) ? "线雕" :
    /(?:拉皮|微拉美)/.test(text) ? "面部提升" :
    /(?:光子嫩肤)/.test(text) ? "光子嫩肤" : "医美项目"
  );
  const aspect = /(?:区别|对比|怎么选)/.test(text) ? "的一般区别" :
    /(?:恢复|术后|多久|注意)/.test(text) ? "的一般恢复与注意事项" :
    /(?:流程)/.test(text) ? "的一般咨询流程" : "的一般原理";
  return `${project}${aspect}`;
};

/**
 * 将“院方可变事实”和“稳定的基础科普”明确拆开。基础科普只把经过
 * 最小化后的主题交给模型；院方、医生、产品、价格与服务信息始终绑定
 * 知识库/GraphRAG 的已准入证据。
 */
export function routeAcquisitionAnswer({ message = "", intent = "", analysis = {}, status = "completed" } = {}) {
  const text = String(message).trim();
  if (status !== "completed" || RISK_OR_RESTRICTED_INTENTS.has(intent)) {
    return { route:"deterministic_safety", retrieval_strategy:"none", tool_execution:"blocked", freshness:freshnessFor(intent, text), model_generation_mode:"disabled", reason:"risk_or_restricted", version:ACQUISITION_ANSWER_ROUTING_VERSION };
  }
  if (ENTERPRISE_INTENTS.has(intent)
    || ENTERPRISE_FACT_PATTERN.test(text)
    || (analysis?.entities?.doctors || []).length
    || (analysis?.entities?.products || []).length
    || (analysis?.entities?.projects || []).length) {
    return enterprisePlan({ message:text, intent, analysis });
  }
  if (["project_explanation", "project_comparison", "conversation_followup"].includes(intent) && GENERIC_EDUCATION_PATTERN.test(text) && GENERIC_PROJECT_PATTERN.test(text)) {
    return {
      route:"generic_model_education",
      retrieval_strategy:"none",
      tool_execution:"not_requested",
      freshness:freshnessFor(intent, text),
      model_generation_mode:"generic_education",
      generic_education_topic:topicFor(text, analysis),
      reason:"stable_general_education",
      version:ACQUISITION_ANSWER_ROUTING_VERSION
    };
  }
  return { route:"deterministic_policy", retrieval_strategy:"none", tool_execution:"not_requested", freshness:freshnessFor(intent, text), model_generation_mode:"grounded_copy_only", reason:"structured_dialogue_or_ambiguous", version:ACQUISITION_ANSWER_ROUTING_VERSION };
}
