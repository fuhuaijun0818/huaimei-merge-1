import { canUseSemanticQuestion } from "./acquisition-semantic-policy.mjs";
import { randomUUID } from "node:crypto";
import { completeAgentWithLlm, getLlmStatus, planDialogueTurnWithLlm } from "./llm-client.mjs";
import { applyTurnPlanContext } from './acquisition-turn-plan.mjs';
import { INTENT_ONTOLOGY } from './acquisition-intent.mjs';
import { applyPresalesDialogue } from './acquisition-presales-dialogue.mjs';
import { retrieveGraphRagKnowledge } from "./graphrag-client.mjs";
import { ACQUISITION_CONVERSATION_STYLE_VERSION, determineAcquisitionDialogueStage, evaluateAcquisitionConversationCopy, normalizeAcquisitionConversationCopy } from "./acquisition-conversation-style.mjs";
import { analyzeAcquisitionEmotion, enrichAcquisitionResponseWithEmotion } from "./acquisition-emotion.mjs";
import { routeAcquisitionAnswer } from "./acquisition-answer-routing.mjs";
import { extractNamedDoctorName, isDoctorRecommendationIntent, recognizeAcquisitionIntent } from "./acquisition-intent.mjs";
import { deriveChoicePrompt, normalizePendingChoice } from "./acquisition-choice-slots.mjs";
import { buildDoctorComparisonResponse, buildDoctorRecommendationResponse, buildProductAttributeResponse, buildPublicKnowledgeResponse, buildStarProductResponse, getHuameiKnowledgeStatus, loadHuameiKnowledge, publicEvidenceFor, retrieveDoctorKnowledge, retrieveHuameiKnowledge, retrieveNamedDoctorProfiles } from "./huamei-knowledge.mjs";
import { projectKnowledge } from "../src/project-knowledge.js";
import { approvedKnowledgeRecordIds, getKnowledgeAdmissionStatus, isKnowledgeRecordAdmitted } from "./knowledge-release-policy.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { publicationRequestContext } from "./knowledge-publication.mjs";
import { isValidatedFormalLoadTaxonomyEntry } from "./platform/formal-load-taxonomy.mjs";
import { postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresAgentRunStore } from "./persistence/postgres-agent-run-store.mjs";

export const AGENT_DEFINITIONS = [
  {
    id: "A-01", slug: "acquisition-consultant", name: "AI获客顾问·小美", version: "5.9.0",
    role: "项目科普与需求识别", stage: "售前", status: "running", execution_level: "L2_controlled",
    capabilities: ["project_explanation", "need_clarification", "lead_capture"],
    forbidden: ["medical_diagnosis", "suitability_judgement", "effect_guarantee"], knowledge_version: "huamei-knowledge@v1+project-knowledge@3.2+intent-engine@3.3+choice-slots@1.0+conversation-style@2.3+emotion@1.0+answer-routing@1.1+orchestration@1.0"
  },
  {
    id: "A-02", slug: "appointment-specialist", name: "AI邀约专员·小美", version: "2.7.0",
    role: "预约推进与提醒", stage: "售前", status: "running", execution_level: "L2_controlled",
    capabilities: ["slot_recommendation", "appointment_reminder", "silent_lead_nurture"],
    forbidden: ["private_pricing", "excessive_outreach", "treatment_advice"], knowledge_version: "appointment-strategy@2.6"
  },
  {
    id: "A-03", slug: "arrival-assistant", name: "AI接待助手·小华", version: "1.9.0",
    role: "到院交接与信息汇总", stage: "售中", status: "running", execution_level: "L1_approval_required",
    capabilities: ["arrival_instruction", "handover_summary", "information_completion"],
    forbidden: ["consultation_plan", "price_commitment"], knowledge_version: "arrival-process@1.9"
  },
  {
    id: "A-04", slug: "aftercare-assistant", name: "AI售后关怀·安安", version: "2.3.0",
    role: "普通随访与异常识别", stage: "售后", status: "running", execution_level: "L1_approval_required",
    capabilities: ["general_followup", "satisfaction_survey", "abnormality_escalation"],
    forbidden: ["abnormality_treatment", "medication_advice", "clinical_result_judgement"], knowledge_version: "aftercare-knowledge@2.2"
  },
  {
    id: "A-05", slug: "repurchase-advisor", name: "AI复购顾问·悦悦", version: "0.9.0",
    role: "复购窗口与会员关怀", stage: "售后", status: "canary", execution_level: "L1_approval_required",
    capabilities: ["repurchase_window_detection", "interest_change_summary", "human_recommendation"],
    forbidden: ["automatic_discount", "medical_recommendation"], knowledge_version: "repurchase-strategy@0.9"
  },
  {
    id: "A-06", slug: "compliance-guardian", name: "合规守门员", version: "4.2.0",
    role: "内容与动作风险控制", stage: "全阶段", status: "running", execution_level: "L4_mandatory",
    capabilities: ["risk_detection", "medical_boundary", "consent_gate", "audit_record"],
    forbidden: ["disable_core_guardrail"], knowledge_version: "compliance-rules@4.2"
  }
];

const PROJECT_KNOWLEDGE = {
  "热玛吉": {
    knowledge_id: "K-001", version: "3.2", aliases: ["热玛吉", "thermage", "射频紧肤"],
    summary: "热玛吉属于射频类紧肤项目。一般咨询可说明基本作用方式、常见流程和到院评估安排；具体参数、个体适用性与预期效果须由医生评估。"
  },
  "线雕": {
    knowledge_id: "K-002", version: "2.8", aliases: ["线雕", "埋线提升", "轮廓重塑"],
    summary: "线雕是通过医用材料进行组织提升的项目类别。可介绍一般流程、术前评估与常见恢复安排；是否适合及具体方案须由医生面诊判断。"
  },
  "拉皮/微拉美": {
    knowledge_id: "K-003", version: "1.6", aliases: ["拉皮", "微拉美", "面部提升"],
    summary: "拉皮与微拉美属于面部提升相关项目。一般咨询只说明项目差异、就诊流程和评估方式；手术方案、风险与个体适用性必须转专业医生。"
  }
};

const LEGACY_KNOWLEDGE_IDS = {
  "热玛吉": "K-001",
  "线雕提升": "K-002",
  "拉皮/微拉美面部提升": "K-003"
};

const KNOWLEDGE_BOUND_INTENTS = new Set([
  "project_explanation", "project_comparison", "project_discovery_by_concern",
  "product_attribute_verification", "doctor_profile", "doctor_discovery_by_project",
  "doctor_comparison", "doctor_schedule_verification", "price_verification",
  "policy_verification", "directory_discovery", "service_information", "conversation_followup"
]);

// 项目资料必须完成医务与合规双审后，才可进入对客检索。
// 未完成双审时仅使用去除机构宣传、绝对化表达后的审核视图，且不作为正式引用。
const customerApprovedProjectKnowledge = () => projectKnowledge.filter((item) => item.allowedForCustomerResponse === true);

// 发布包生效时，对客项目资料必须以“正式启用版本”为准：内置数据集只在没有生效包时兜底。
// 否则会出现管理端已经激活或回滚、前台仍按内置资料回答的情况（C-013 AC4）。
const projectNameFromPublishedChunk = (chunk) => {
  const head = String(chunk?.title || "").split(/[｜|—–-]/)[0].trim();
  if (head) return head;
  const tag = (chunk?.tags || []).map((value) => String(value || "").trim()).filter(Boolean)[0];
  return tag || "已发布资料";
};

const publishedProjectKnowledge = (tenantId) => {
  const publication = publicationRequestContext.getStore();
  if (!publication?.package || !(publication.revision > 0)) return null;
  if (publication.tenantId !== normalizeTenantId(tenantId)) return null;
  const chunks = publication.package.text_index?.chunks || [];
  if (!chunks.length) return null;
  return chunks.map((chunk) => ({
    id: String(chunk.record_id || chunk.document_id || ""),
    knowledge_id: String(chunk.record_id || chunk.document_id || ""),
    project: projectNameFromPublishedChunk(chunk),
    cardTitle: String(chunk.title || ""),
    sourceTitle: String(chunk.title || ""),
    brandOrModel: "",
    parts: [String(chunk.title || ""), ...(chunk.tags || []).map((value) => String(value))],
    cardTags: (chunk.tags || []).map((value) => String(value)),
    efficacyLabels: [],
    introduction: String(chunk.content || ""),
    efficacy: String(chunk.content || ""),
    excerpt: String(chunk.content || ""),
    coverage: 100,
    status: "正式发布包",
    published: true,
    package_id: String(publication.package.id || ""),
    source_relative_path: chunk.source_reference || null,
    expires_at: chunk.expires_at || null
  })).filter((item) => item.id);
};

const searchableProjectKnowledge = (tenantId) => {
  const published = publishedProjectKnowledge(tenantId);
  if (published) return published;
  const approved = customerApprovedProjectKnowledge();
  if (approved.length) return approved;
  const admission = getKnowledgeAdmissionStatus(tenantId);
  if (admission.mode === "enforce") {
    const released = approvedKnowledgeRecordIds(tenantId);
    return projectKnowledge.filter((item) => released.has(item.id));
  }
  return projectKnowledge.map((item) => ({ ...item, status:"待双审，仅限一般说明", provisionalReviewView:true }));
};

const KNOWLEDGE_CONCERN_GROUPS = [
  { triggers: ["抗衰", "抗老", "初老", "松弛", "下垂", "皱纹", "法令纹"], terms: ["抗衰", "抗初老", "紧致", "松弛", "祛皱", "提升", "年轻化"], partTerms:["面部"] },
  { triggers: ["胎记", "太田痣", "鲜红斑痣", "雀斑样痣", "咖啡斑", "色素痣", "血管瘤"], terms: ["胎记", "太田痣", "鲜红斑痣", "雀斑样痣", "咖啡斑", "色素痣", "皮肤美容"], partTerms:["面部", "皮肤"] },
  { triggers: ["暗沉", "发黄", "美白", "提亮", "色斑", "斑点", "痘印"], terms: ["提亮肤色", "美白", "祛斑", "嫩肤", "光子", "皮秒"], partTerms:["面部"] },
  { triggers: ["痘坑", "毛孔", "肤质粗糙"], terms: ["缩小毛孔", "嫩肤", "肌肤水润"], partTerms:["面部"] },
  { triggers: ["瘦脸", "咬肌", "轮廓", "下颌线", "下巴", "脸型"], terms: ["瘦脸", "去咬肌", "轮廓", "下巴", "脸型", "提升轮廓"], partTerms:["面部"] },
  { triggers: ["眼袋", "泪沟", "双眼皮", "眼睛", "眼周", "眉形"], terms: ["眼袋", "泪沟", "双眼皮", "眼部", "眉形", "眼周年轻化"], partTerms:["眼部", "眉部", "面部"] },
  { triggers: ["鼻子", "鼻部", "鼻梁", "鼻尖", "鼻翼", "鼻头", "隆鼻"], terms: ["鼻部", "鼻型", "隆鼻", "鼻尖", "鼻翼", "鼻梁"], partTerms:["鼻部"] },
  { triggers: ["胸部", "丰胸", "隆胸"], terms: ["胸部", "丰胸", "隆胸", "乳房"], partTerms:["胸部"] },
  { triggers: ["减脂", "吸脂", "瘦腰", "瘦腿", "瘦手臂", "塑形"], terms: ["吸脂", "瘦腰", "瘦腿", "瘦手臂", "塑形"], partTerms:["身体", "腰腹", "腿部", "手臂"] },
  { triggers: ["缺水", "补水", "干纹", "干燥"], terms: ["补水", "水润", "保湿", "玻尿酸"], partTerms:["面部"] }
];

// 明确项目提问优先走项目意图匹配；较短的上位词不能覆盖同一位置的具体项目词。
// 例如“隆鼻术”归入鼻部整形，“假体隆鼻”则只命中假体隆鼻。
const PROJECT_INTENT_ALIASES = {
  "鼻部整形": ["鼻部整形", "鼻整形", "鼻综合整形", "鼻综合", "隆鼻手术"],
  "假体隆鼻": ["假体隆鼻"],
  "玻尿酸填充": ["玻尿酸填充", "玻尿酸注射"],
  "光子嫩肤": ["光子嫩肤", "光子美肤"],
  "抗初老/紧致除皱": ["抗初老", "紧致除皱", "面部抗衰", "面部抗老"],
  "拉皮/微拉美面部提升": ["拉皮手术", "拉皮", "微拉美"],
  "泪沟填充": ["泪沟填充", "填泪沟"],
  "隆胸/胸部整形": ["胸部整形", "隆胸手术", "隆胸"],
  "面部轮廓整形": ["面部轮廓整形", "轮廓整形", "改脸型", "下颌角整形", "颧骨内推"],
  "皮秒激光祛斑": ["皮秒激光祛斑", "皮秒祛斑", "皮秒激光", "皮秒"],
  "祛眼袋": ["祛眼袋手术", "祛眼袋", "去眼袋手术", "去眼袋"],
  "热玛吉": ["热玛吉", "thermage"],
  "双眼皮": ["双眼皮手术", "双眼皮"],
  "提眉": ["提眉手术", "提眉"],
  "吸脂塑形": ["吸脂塑形", "吸脂手术", "吸脂"],
  "下巴整形": ["下巴整形", "下巴塑形", "垫下巴"],
  "线雕提升": ["线雕提升", "埋线提升", "线雕"],
  "注射瘦脸": ["注射瘦脸", "瘦脸针", "肉毒瘦脸"],
  "自体脂肪隆胸": ["自体脂肪隆胸", "脂肪隆胸"],
  "自体脂肪填充": ["自体脂肪填充", "脂肪填充"]
};

const normalizeSearchText = (value = "") => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const EXPLICIT_RECORD_OVERRIDES = [
  { aliases:["隆鼻术", "隆鼻", "鼻成形术", "rhinoplasty"], project:"鼻部整形", recordId:"KB-P-033" },
  { aliases:["鼻综合整形", "鼻综合"], project:"鼻部整形", recordId:"KB-P-026" },
  { aliases:["假体隆鼻"], project:"假体隆鼻", recordId:"KB-P-031" }
];

const explicitProjectIntents = (message = "") => {
  const query = normalizeSearchText(message);
  const candidates = [];
  Object.entries(PROJECT_INTENT_ALIASES).forEach(([project, aliases]) => aliases.forEach((alias) => {
    const term = normalizeSearchText(alias);
    let start = query.indexOf(term);
    while (term && start >= 0) {
      candidates.push({ project, alias, term, start, end:start + term.length });
      start = query.indexOf(term, start + 1);
    }
  }));
  EXPLICIT_RECORD_OVERRIDES.forEach((override) => override.aliases.forEach((alias) => {
    const term = normalizeSearchText(alias);
    let start = query.indexOf(term);
    while (term && start >= 0) {
      candidates.push({ project:override.project, recordId:override.recordId, alias, term, start, end:start + term.length, override:true });
      start = query.indexOf(term, start + 1);
    }
  }));
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => b.term.length - a.term.length || Number(Boolean(b.override)) - Number(Boolean(a.override)) || a.start - b.start)) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    if (accepted.some((item) => item.project === candidate.project)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
};

const recordIdentityTerms = (item) => [item.project, item.cardTitle, item.sourceTitle]
  .flatMap((value) => String(value || "").split(/[>、，,/｜—]/))
  .map(normalizeSearchText)
  .filter((value) => value.length >= 2);

const bestProjectRecord = (project, matchedTerm, items, recordId = "") => items
  .filter((item) => item.project === project)
  .filter((item) => !recordId || item.id === recordId)
  .map((item, sourceIndex) => {
    const identities = recordIdentityTerms(item);
    const projectName = normalizeSearchText(item.project);
    const cardTitle = normalizeSearchText(item.cardTitle);
    const sourceTitle = normalizeSearchText(item.sourceTitle);
    let score = Number(item.coverage || 0) / 100;
    if (identities.includes(matchedTerm)) score += 100;
    if (cardTitle === projectName) score += 40;
    if (sourceTitle === projectName) score += 25;
    return { item, score, sourceIndex, matchType:"explicit" };
  })
  .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)[0];

const compactKnowledgeText = (value = "", limit = 260) => String(value)
  .replace(/\s+/g, " ")
  .replace(/(?:立竿见影|永久|绝对安全|安全无痛|无痛|零风险|快速见效|即刻见效)/g, "")
  .trim()
  .slice(0, limit);

const knowledgeIdentityTerms = (item) => [...new Set([
  item.project, item.cardTitle, item.sourceTitle, item.brandOrModel,
  ...(item.cardTags || []), ...(item.efficacyLabels || [])
].flatMap((value) => String(value || "").split(/[—、/｜_\-]/)).map((value) => value.trim()).filter((value) => value.length >= 2))];

// 显式项目识别只认项目名、品牌/型号与登记别名。此前把资料标题按分隔符切片，
// 会让“痛感明显吗”这类追问因标题里的“明显”被误判成点名的项目提问，随后把
// 图片 OCR 原文当成答复讲给客户。
const explicitProjectTerms = (item) => [...new Set([
  item.project,
  item.brandOrModel,
  ...(PROJECT_INTENT_ALIASES[item.project] || [])
].map((value) => String(value || "").trim()).filter((value) => value.length >= 2))];

const projectKnowledgeText = (item) => [
  item.project, item.cardTitle, item.sourceTitle, item.brandOrModel,
  ...(item.parts || []), ...(item.cardTags || []), ...(item.efficacyLabels || []),
  item.introduction, item.efficacy
].join(" ").toLowerCase();

export function retrieveProjectKnowledge(message, context = {}, limit = 3) {
  const query = String(message || "").toLowerCase();
  const searchableItems = searchableProjectKnowledge(context.tenant_id);
  const explicitIntents = explicitProjectIntents(message);
  if (explicitIntents.length) {
    return explicitIntents
      .map((intent) => bestProjectRecord(intent.project, intent.term, searchableItems, intent.recordId))
      .filter(Boolean)
      .slice(0, Math.min(Math.max(Number(limit) || 3, 1), 5));
  }
  const firstInterest = context.interests?.[0];
  const interestName = String(typeof firstInterest === "string" ? firstInterest : firstInterest?.name || "").toLowerCase();
  const activeGroups = KNOWLEDGE_CONCERN_GROUPS.filter((group) => group.triggers.some((trigger) => query.includes(trigger)));
  const scored = searchableItems.map((item, sourceIndex) => {
    const haystack = projectKnowledgeText(item);
    const identityHaystack = [item.project, item.cardTitle, item.sourceTitle, ...(item.parts || [])].join(" ").toLowerCase();
    let score = 0;
    const primaryTerms = [...new Set([item.project, item.cardTitle].flatMap((value) => String(value || "").split(/[—、/｜_\-]/)).map((value) => value.trim()).filter((value) => value.length >= 2))];
    const secondaryTerms = [...new Set([item.sourceTitle, item.brandOrModel].flatMap((value) => String(value || "").split(/[—、/｜_\-]/)).map((value) => value.trim()).filter((value) => value.length >= 2))];
    const descriptiveTerms = [...new Set([...(item.cardTags || []), ...(item.efficacyLabels || [])].map((value) => String(value || "").trim()).filter((value) => value.length >= 2))];
    for (const term of primaryTerms) {
      const normalized = term.toLowerCase();
      const position = query.indexOf(normalized);
      if (position >= 0) score += 70 - Math.min(position, 20);
      if (interestName && (interestName.includes(normalized) || normalized.includes(interestName))) score += 48;
    }
    for (const term of secondaryTerms) {
      const normalized = term.toLowerCase();
      if (query.includes(normalized)) score += 18;
    }
    for (const term of descriptiveTerms) {
      const normalized = term.toLowerCase();
      if (query.includes(normalized)) score += 12;
    }
    for (const group of activeGroups) {
      const itemParts = (item.parts || []).map((part) => String(part).toLowerCase());
      if (group.partTerms?.length && !group.partTerms.some((part) => itemParts.some((itemPart) => itemPart.includes(part.toLowerCase())))) continue;
      const identityMatches = group.terms.filter((term) => identityHaystack.includes(term.toLowerCase())).length;
      if (identityMatches) score += Math.min(identityMatches, 5) * 8;
    }
    return { item, score, sourceIndex };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);

  const selected = [];
  const seenProjects = new Set();
  const topScore = scored[0]?.score || 0;
  const minimumScore = Math.max(12, topScore * 0.45);
  for (const entry of scored) {
    if (entry.score < minimumScore) continue;
    if (seenProjects.has(entry.item.project)) continue;
    seenProjects.add(entry.item.project);
    selected.push(entry);
    if (selected.length >= Math.min(Math.max(Number(limit) || 3, 1), 5)) break;
  }
  return selected;
}

const safeProjectSummary = (item) => {
  const intro = compactKnowledgeText(item.introduction || item.excerpt, 240);
  const directions = (item.efficacyLabels || []).slice(0, 4).map((label) => compactKnowledgeText(label, 40)).filter(Boolean);
  return `${intro}${directions.length ? ` 常见介绍方向包括：${directions.join("、")}。` : ""}`;
};

const shortProjectSummary = (item) => {
  const intro = compactKnowledgeText(item.introduction || item.excerpt, 110).split(/[。；]/)[0];
  const directions = (item.efficacyLabels || []).slice(0, 3).map((label) => compactKnowledgeText(label, 30)).filter(Boolean);
  return `${intro}${directions.length ? `，常见方向有${directions.join("、")}` : ""}`;
};

// 面向客户的首轮说明只保留一个清楚的知识点。原始资料中的长段落仍保留在
// structured_data/citations 供追溯，不能原样塞进聊天气泡。
const customerProjectSummary = (item) => {
  const definition = compactKnowledgeText(item.introduction || item.excerpt, 200).split(/[。；]/)[0];
  if (/(?:是指|指的是|是通过|是一种|是一项|属于|也称为)/.test(definition)) return `${definition}。`;
  const project = compactKnowledgeText(item.project || item.cardTitle || "这个项目", 40);
  const directions = (item.efficacyLabels || [])
    .slice(0, 3)
    .map((label) => compactKnowledgeText(label, 24))
    .filter(Boolean);
  if (directions.length) return `${project}常见会从${directions.join("、")}等方向介绍。`;

  const firstSentence = compactKnowledgeText(item.introduction || item.excerpt, 100)
    .split(/[。；]/)[0]
    .split(/[，,]/)
    .slice(0, 2)
    .join("，")
    .replace(/[，,：:；;。]+$/u, "")
    .slice(0, 64);
  return firstSentence ? `${firstSentence}。` : `${project}可以先了解一般原理和到院流程。`;
};

// “丰胸”命中“胸部整形”时，不能直接取项目标签。原始资料的标签混入了
// 修复、乳头美化等并列服务，作为首轮答案会偏离客户正在问的丰胸方向。
const breastProjectSummary = () =>
  "丰胸可以先分为假体隆胸和自体脂肪隆胸两种方向。假体方式涉及医用假体，自体脂肪方式使用自身脂肪移植到胸部。具体采用哪一种，需要医生面诊确认。";

const selectedBreastProjectType = (message = "") => {
  const text = String(message).trim();
  // 与意图层保持一致：这是用户针对上轮“假体 / 自体脂肪丰胸”问题给出的
  // 选项，不要求客户完整复述“自体脂肪隆胸”。
  const implant = /(?:假体丰胸|假体隆胸|丰胸假体|^假体(?:方式)?[。！？!?]?$)/.test(text);
  const fat = /(?:自体脂肪丰胸|自体脂肪隆胸|脂肪丰胸|脂肪隆胸|^自体脂肪(?:方式)?[。！？!?]?$|^脂肪方式[。！？!?]?$)/.test(text);
  // 同时点名两种方式时是比较题，不能把前一个关键词误当成用户已作选择。
  if (implant && fat) return "";
  if (implant) return "implant";
  if (fat) return "fat";
  return "";
};

// pending choice 会以 storage value（autologous_fat）进入下一轮会话；
// 所有回答分支都先归一为 fat / implant，避免“原理”“恢复”等省略主语的追问
// 忘记刚刚已确认的丰胸方式。
const normalizeBreastMethod = (value = "") => {
  const text = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (["implant", "假体", "假体丰胸", "假体隆胸"].includes(text)) return "implant";
  if (["fat", "autologous_fat", "autologous-fat", "自体脂肪", "自体脂肪丰胸", "自体脂肪隆胸", "脂肪丰胸", "脂肪隆胸"].includes(text)) return "fat";
  return "";
};

const breastProjectForMethod = (type = "") => type === "implant"
  ? "假体隆胸"
  : type === "fat"
    ? "自体脂肪隆胸"
    : "";

const breastPrincipleMessage = (type = "") => type === "implant"
  ? "假体丰胸的原理，是通过植入医用假体增加胸部大小、改善形态。"
  : "自体脂肪丰胸的原理，是将自身其他部位的脂肪提取、处理后，再移植到胸部。";

const selectedBreastProjectSummary = (type) => type === "implant"
  ? "假体丰胸是通过植入医用假体来增加胸部大小、改善形态的方式。具体可用的假体形态和型号，需要结合医生面诊与院方当前产品确认。"
  // 上一轮已说明“具体采用哪一种需面诊确认”后，客户选择自体脂肪时只需
  // 承接已选方向并补充新信息，避免在相邻气泡里重复同一句边界提示。
  : "您选的是自体脂肪丰胸：将自身其他部位脂肪处理后移植到胸部。";

const RISK_RULES = [
  { id: "MEDICAL_EMERGENCY", level: "L4", category: "medical_emergency", words: ["呼吸困难", "喘不过气", "胸闷气短", "气短", "大量出血", "止不住血", "血止不住", "血一直止不住", "出血不止", "纱布一直湿透", "意识不清", "昏迷", "胸痛", "休克", "喉头水肿", "全身过敏", "严重感染", "发白发紫", "视物模糊", "看东西有点模糊", "看不清", "头晕恶心", "心慌"], action: "handover", critical:true },
  { id: "MEDICAL_SUITABILITY", level: "L4", category: "medical_boundary", words: ["适不适合", "是否适合", "能不能做", "禁忌", "诊断", "什么方案", "治疗参数", "很适合", "比较适合", "适合做", "建议做", "建议考虑", "我适合什么", "我需要做吗", "我需不需要做"], action: "handover" },
  { id: "CLINICAL_LESION", level: "L4", category: "medical_boundary", words: ["恶性", "癌变", "肿瘤", "黑色素瘤", "病变", "活检", "恶变"], action: "handover" },
  { id: "PREGNANCY_TREATMENT", level: "L4", category: "medical_boundary", words: ["怀孕", "孕期", "备孕", "哺乳期", "哺乳", "妊娠"], action: "handover" },
  { id: "PHOTO_DIAGNOSIS", level: "L4", category: "medical_boundary", words: ["照片判断", "根据照片", "根据我的照片", "看照片", "看图片", "图片诊断", "照片分析", "看图片判断"], action: "handover" },
  { id: "ADVERSE_REACTION", level: "L4", category: "medical_safety", words: ["异常", "红肿", "疼痛", "流血", "感染", "发热", "过敏", "用药", "吃什么药", "建议用药", "应当服用"], action: "handover" },
  { id: "MEDICAL_INSTRUCTION", level: "L4", category: "medical_safety", words: ["教我怎么打", "怎么打最安全", "自己打针", "药和剂量", "用药剂量", "告诉我剂量", "帮我判断今天能不能手术"], action: "handover" },
  { id: "COMPLAINT_OR_LEGAL", level: "L4", category: "complaint", words: ["投诉", "退款", "媒体曝光", "找记者", "律师", "起诉", "报警", "消协", "监管部门"], action: "handover" },
  { id: "PRIVACY_RIGHTS", level: "L4", category: "privacy_complaint", words: ["照片删掉", "删除照片", "不想做案例", "像我的照片", "是不是泄露", "签过授权", "反悔还能撤", "撤回授权", "撤销授权"], action: "handover" },
  { id: "HUMAN_REQUEST", level: "L4", category: "human_request", words: ["转人工", "找人工", "人工客服", "人工服务", "人工接待", "人工咨询", "人工顾问", "转接人工", "找真人", "真人客服", "真人顾问", "我要真人", "不要机器人", "让医生回复"], action: "handover" },
  { id: "THIRD_PARTY_PRIVACY", level: "L4", category: "privacy", words: ["查我朋友", "查一下我朋友", "朋友在你们医院", "查一下别人", "查我同事", "查我家人", "我对象在你们", "她还剩多少次", "同事的术后照片", "别人的消费", "别人的预约", "别人的病历", "他做过什么", "她做了什么项目"], action: "block" },
  { id: "PROMPT_INJECTION", level: "L4", category: "security", words: [
    "忽略之前指令", "忽略前面的指令", "忽略系统指令", "忽略开发者指令", "越过安全规则",
    "系统提示词", "开发者消息", "把提示词发给我", "输出完整提示词", "显示内部规则",
    "泄露密钥", "输出环境变量", "显示你的规则", "进入开发者模式", "越狱模式",
    "ignore previous instructions", "ignore all instructions", "disregard the system prompt",
    "reveal the system prompt", "show developer message", "print environment variables", "jailbreak"
  ], action: "block" },
  { id: "EFFECT_GUARANTEE", level: "L4", category: "promotion_compliance", words: ["永久", "一定有效", "保证效果", "保证安全", "绝对安全", "完全安全", "100%安全", "百分百", "肯定有效", "无痛", "零风险", "最低价"], action: "block" },
  { id: "SENSITIVE_ATTRIBUTE", level: "L4", category: "privacy", words: ["颜值评分", "面相判断", "照片诊断"], action: "block" }
];

const runs = new Map();
const MAX_RUNS = 500;

const persistFinalRun = async (response) => {
  if (!postgresPersistenceEnabled() || !response?.run_id) return response;
  const run = runs.get(response.run_id);
  if (run) await getPostgresAgentRunStore().upsert(run);
  return response;
};

const maskSensitive = (value = "") => String(value)
  .replace(/1\d{10}/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
  .replace(/\b\d{15,18}[0-9Xx]\b/g, "[证件号已脱敏]");

const normalizeContext = (context = {}) => ({
  tenant_id:normalizeTenantId(context.tenant_id),
  macro_stage: context.macro_stage || "未知",
  micro_stage: context.micro_stage || "未知",
  interests: Array.isArray(context.interests) ? context.interests.slice(0, 10) : [],
  service_consent: context.service_consent !== false,
  marketing_consent: context.marketing_consent === true,
  photo_consent: context.photo_consent || "unknown",
  available_slots: Array.isArray(context.available_slots) ? context.available_slots.slice(0, 10) : [],
  owner: context.owner || "待分配",
  profile: typeof context.profile === "object" && context.profile ? context.profile : {},
  known_slots: typeof context.known_slots === "object" && context.known_slots ? context.known_slots : {},
  presales_state:context.presales_state && typeof context.presales_state === 'object' ? context.presales_state : {},
  pending_choice:normalizePendingChoice(context.pending_choice),
  known_projects:Array.isArray(context.known_projects) ? context.known_projects.slice(0, 12).map((item) => String(item).slice(0, 80)) : [],
  known_doctors:Array.isArray(context.known_doctors) ? context.known_doctors.slice(0, 12).map((item) => String(item).slice(0, 40)) : [],
  last_intent:String(context.last_intent || "").slice(0, 80),
  dialogue_stage:String(context.dialogue_stage || "").slice(0, 80),
  recent_turns: Array.isArray(context.recent_turns)
    ? context.recent_turns.slice(-12).map((turn) => ({ role:turn?.role === "assistant" ? "assistant" : "user", content:maskSensitive(turn?.content || "").slice(0, 320) }))
    : [],
  conversation_summary:maskSensitive(context.conversation_summary || "").slice(0, 500),
  session_id:String(context.session_id || "").slice(0, 128),
  turn_index:Math.max(1, Number(context.turn_index) || 1),
  // 连续“没听懂”的轮数，用于连续两次仍无法理解时给出人工入口。
  clarification_streak:Math.max(0, Number(context.clarification_streak) || 0),
  active_critical_risk:context.active_critical_risk && typeof context.active_critical_risk === "object"
    ? { category:String(context.active_critical_risk.category || "").slice(0, 80), rule_id:String(context.active_critical_risk.rule_id || "").slice(0, 80) }
    : null
});

export const inspectRisk = (text = "", { includeHumanRequests = true } = {}) => {
  const normalized = String(text).normalize("NFKC").toLowerCase();
  // 常见注入会在人为敏感词中插空格或标点；风险门禁在匹配时去掉这些分隔符，
  // 但审计仍保留实际命中的规则名称，不记录原始敏感正文。
  const compact = normalized.replace(/[\s_\-.:：，,。!！?？'"“”‘’【\][\]()（）]+/gu, "");
  const matches = RISK_RULES.flatMap((rule) => {
    const hitWords = rule.words.filter((word) => {
      const normalizedWord = String(word).normalize("NFKC").toLowerCase();
      const compactWord = normalizedWord.replace(/[\s_\-.:：，,。!！?？'"“”‘’【\][\]()（）]+/gu, "");
      if (rule.id === "HUMAN_REQUEST") {
        if (!includeHumanRequests) return false;
        const affirmative = compact.replace(/(?:不需要|不用|不要|不想|暂不)(?:再|转接?|找|联系)?(?:人工(?:客服|服务|接待|咨询|顾问)?|真人(?:客服|顾问)?)/g, "");
        return affirmative.includes(compactWord);
      }
      return normalized.includes(normalizedWord) || (compactWord.length >= 4 && compact.includes(compactWord));
    });
    return hitWords.length ? [{ rule_id: rule.id, level: rule.level, category: rule.category, action: rule.action, critical:rule.critical === true, matched_terms: hitWords }] : [];
  });
  return {
    allowed: matches.length === 0,
    decision: matches.some((item) => item.action === "block") ? "block" : matches.some((item) => item.action === "handover") ? "handover" : "allow",
    matches
  };
};

const detectProject = (message, context) => {
  const text = String(message).toLowerCase();
  const byMessage = Object.entries(PROJECT_KNOWLEDGE).find(([, item]) => item.aliases.some((alias) => text.includes(alias.toLowerCase())));
  if (byMessage) return [byMessage[0], byMessage[1]];
  const firstInterest = context.interests[0];
  const interestName = typeof firstInterest === "string" ? firstInterest : firstInterest?.name;
  return interestName && PROJECT_KNOWLEDGE[interestName] ? [interestName, PROJECT_KNOWLEDGE[interestName]] : null;
};

// 项目解释类回答的引用来自内置策划表（只有 knowledge_id/summary，没有文件路径），
// 客户看到的“参考资料”因此无法定位到原始资料。这里按项目名回查公开知识子集里
// 项目介绍目录下的资料记录，补上可追溯的来源路径；查不到时保持原样。
const projectEvidenceSourceCache = new Map();
const projectEvidenceSource = (project) => {
  const key = String(project || "").trim();
  if (!key) return null;
  if (projectEvidenceSourceCache.has(key)) return projectEvidenceSourceCache.get(key);
  let resolved = null;
  try {
    const candidates = retrieveHuameiKnowledge(key, {
      audience: "public",
      pathPrefixes: ["项目介绍/"],
      limit: 5,
      minimumScore: 8
    }).map((hit) => hit?.item || hit).filter((record) => record && String(record.source_relative_path || "").startsWith("项目介绍/"));
    const fileRecord = candidates.find((record) => ["image_ocr", "pdf_text"].includes(record.record_type));
    const picked = fileRecord || candidates.find((record) => record.record_type === "directory_overview") || candidates[0] || null;
    resolved = picked
      ? { source_relative_path:String(picked.source_relative_path), source_record_id:picked.record_id || picked.id || null }
      : null;
  } catch {
    resolved = null;
  }
  projectEvidenceSourceCache.set(key, resolved);
  return resolved;
};

const citation = (title, item) => {
  const fallbackEvidence = item.source_relative_path ? null : projectEvidenceSource(title || item.project);
  return {
  knowledge_id: item.knowledge_id || LEGACY_KNOWLEDGE_IDS[item.project] || item.id,
  source_record_id: item.id || null,
  title: `${title}｜项目介绍`,
  version: item.version,
  usage: "consumer_safe_general_information",
  review_status: item.status || "已发布",
  ...(item.source_relative_path
    ? { source_relative_path:item.source_relative_path }
    : fallbackEvidence ? { source_relative_path:fallbackEvidence.source_relative_path, evidence_source_record_id:fallbackEvidence.source_record_id } : {}),
  ...(item.requires_verification === true ? { requires_verification:true } : {})
  };
};

const handoverMessage = (risk) => {
  const categories = new Set(risk.matches.map((item) => item.category));
  if (categories.has("medical_emergency")) {
    return "您描述的情况可能需要立即处理。请停止继续在线咨询，马上联系医院医务人员；如有呼吸困难、大量出血、意识异常或症状快速加重，请立即拨打120或前往急诊。";
  }
  if (categories.has("medical_safety")) {
    return "您描述的情况涉及异常感受或医疗处置边界，我不能在线判断原因或提供用药建议。请尽快联系医院医务人员；如症状明显、持续或加重，请及时就医。";
  }
  if (categories.has("complaint")) {
    return "我已停止自动推进。这类投诉、退款或法律相关问题需要由人工负责人核实记录和处理，请转人工顾问或客户服务团队继续沟通。";
  }
  if (categories.has("privacy_complaint")) {
    return "您提出的是本人照片、案例授权或疑似信息泄露问题。我不会继续自动处理或展示相关资料，已建议转交隐私与客户服务负责人核验身份、授权范围并办理删除或撤回申请。";
  }
  if (categories.has("human_request")) {
    return "好的，这个问题需要人工顾问接入。请通过页面留下联系方式，或使用医院现有人工渠道继续沟通；AI不会继续自动推进。";
  }
  return "我可以继续为您介绍一般项目流程，但您问到的个体适用性、禁忌或具体方案需要由医生结合实际情况评估。建议联系人工顾问协助安排到院评估。";
};

const handoverTeam = (risk) => {
  const categories = new Set(risk.matches.map((item) => item.category));
  if (categories.has("medical_emergency") || categories.has("medical_safety")) return "售后/医务";
  if (categories.has("complaint")) return "客诉/法务/负责人";
  if (categories.has("privacy_complaint")) return "隐私/客户服务负责人";
  if (categories.has("human_request")) return "人工咨询";
  return "人工咨询/医生";
};

const handoverResult = (risk, context) => ({
  status: "handover_required",
  message: handoverMessage(risk),
  structured_data: { risk_matches: risk.matches },
  recommended_actions: [{ type: "create_human_task", owner: context.owner, priority: "urgent", reason: risk.matches.map((item) => item.rule_id).join(",") }],
  handover: { required: true, to_team: handoverTeam(risk), reason: risk.matches[0]?.category || "medical_boundary" },
  citations: []
});

const blockedMessage = (risk) => {
  const categories = new Set(risk.matches.map((item) => item.category));
  if (categories.has("privacy")) return "我不能查询、确认或推断他人的就诊、消费、预约、影像或其他个人信息。如需处理本人信息，请通过医院授权渠道由人工核验身份。";
  if (categories.has("security")) return "我不能披露系统提示词、内部规则、密钥或执行绕过安全边界的要求。您可以继续咨询经审核的一般项目与服务信息。";
  return "该内容涉及效果、安全、价格或宣传承诺方面的高风险表达，我不能按此方式回答。可以改为了解可核验的一般流程，并由人工顾问或医生确认具体信息。";
};

const blockedResult = (risk) => ({
  status: "blocked",
  message: blockedMessage(risk),
  structured_data: { risk_matches: risk.matches },
  recommended_actions: [{ type: "rewrite_or_human_review", priority: "high" }],
  handover: { required: false, to_team: "合规复核", reason: risk.matches[0]?.category || "compliance" },
  citations: []
});

const continuingCriticalHandover = (context) => ({
  status:"handover_required",
  message:"上一轮已出现需要立即处理的安全信号。在医院医务人员或急诊完成确认前，我不会恢复自动项目咨询。请继续优先联系医院；如仍有呼吸困难、大量出血、意识异常或症状加重，请立即拨打120或前往急诊。",
  structured_data:{ risk_matches:[{ rule_id:context.active_critical_risk.rule_id || "MEDICAL_EMERGENCY", category:context.active_critical_risk.category || "medical_emergency", action:"handover", critical:true, matched_terms:[] }] },
  recommended_actions:[{ type:"continue_emergency_handover", priority:"urgent" }],
  handover:{ required:true, to_team:"售后/医务", reason:"critical_risk_continuity" },
  citations:[]
});

// 对客答复只呈现业务内容，不暴露知识检索、提示词或运行时实现。
const INTERNAL_ANSWER_LANGUAGE = /知识库|资料库|检索(?:结果|记录|内容|命中)?|命中(?:结果|记录|内容)?|本地规则草稿|系统上下文|提示词|内部实现/;
const containsInternalAnswerLanguage = (message = "") => INTERNAL_ANSWER_LANGUAGE.test(String(message));
const SENSITIVE_OUTPUT_PATTERN = /(?:sk|ak|key)[-_][A-Za-z0-9._-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bHUAMEI_[A-Z0-9_]+\s*=|\b(?:DATABASE_URL|REDIS_URL)\s*=/i;
const containsSensitiveOutput = (message = "") => SENSITIVE_OUTPUT_PATTERN.test(String(message));
const UNEXECUTED_ACTION_CLAIM = /(?:我(?:会|将)|将为您|马上为您|随后.{0,12})(?:转接|联系|预约|安排|提交|创建)/;
const containsUnexecutedActionClaim = (message = "") => UNEXECUTED_ACTION_CLAIM.test(String(message));
const REMOTE_SUITABILITY_PROBE = /(?:初步|在线|先)?判断.{0,10}是否适合|帮您.{0,8}判断.{0,10}适合|可供提取的脂肪|是否有较多.{0,8}脂肪|(?:请问|想了解).{0,12}(?:您)?(?:目前)?(?:胸部|身体).{0,12}(?:基础条件|脂肪量|皮肤张力|胸廓)/u;
const containsRemoteSuitabilityProbe = (message = "") => REMOTE_SUITABILITY_PROBE.test(String(message));

const PRICE_OR_POLICY_INTENT = /(?:价格|报价|多少钱|费用|预算|活动|优惠|政策|折扣|赠品|套餐|储值|权益|有效期)/i;

const nextSalesQuestion = (context, intent = "") => {
  const recentAssistantText = context.recent_turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join(" ");
  if (["project_explanation", "conversation_followup"].includes(intent)) {
    return /一般原理|恢复安排|到院流程/.test(recentAssistantText)
      ? "您现在更在意自然度、恢复时间，还是预算？"
      : "还有其他想了解的吗？或者帮您预约专家做进一步分析？";
  }
  if (intent === "project_comparison") return "您比较时更在意作用方式、恢复安排，还是到院流程？";
  if (intent === "project_discovery_by_concern") return "这些方向里，您想先从哪一个了解？";
  if (!context.profile.concern && !context.interests.length) return "您更关注哪个部位，或主要想改善什么问题？";
  if (!context.known_slots.time_preference) return "您更希望近期了解，还是先做资料比较后再安排到院？";
  if (!context.known_slots.budget) return "预算有大致范围吗？不方便回答也可以跳过。";
  return "您想继续了解一般流程，还是请人工顾问核验当前价格与可约信息？";
};

const dedupeCitations = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.source_record_id || item.knowledge_id || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
};

const compactGraphEvidence = (value = "") => String(value)
  .replace(/(?:永久|绝对安全|保证效果|保证安全|百分百|100%|无痛|零风险|最低价|立竿见影|即刻见效|快速见效)/gi, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 900);

const normalizeGraphText = (value = "") => String(value)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

const GRAPH_QUERY_STOP_TERMS = new Set([
  "我想", "想做", "想了解", "了解一下", "请问", "可以", "这个", "那个", "目前", "相关",
  "项目", "资料", "医院", "华美", "怎么", "什么", "哪个", "哪位", "推荐", "医生", "院长",
  "脸上", "面部", "一块", "比较大", "很大", "假体", "形状", "是不是", "属于"
]);

const graphQueryAliases = (query = "") => {
  const aliases = [];
  if (/(?:去[^，。！？?]{0,8}痣|祛痣|点痣|黑痣|色素痣)/.test(query)) {
    aliases.push("点痣", "CO2激光点痣", "色素痣", "黑痣");
  }
  return aliases;
};

const graphQueryTerms = (query = "") => {
  const terms = [...graphQueryAliases(query)];
  const segmenter = new Intl.Segmenter("zh-CN", { granularity:"word" });
  for (const segment of segmenter.segment(String(query).normalize("NFKC").toLowerCase())) {
    const term = normalizeGraphText(segment.segment);
    if (segment.isWordLike && term.length >= 2 && !GRAPH_QUERY_STOP_TERMS.has(term)) terms.push(term);
  }
  return [...new Set(terms.map(normalizeGraphText).filter((term) => term.length >= 2))];
};

const GRAPH_FACET_GROUPS = Object.freeze([
  { pattern:/(?:恢复期?|术后|拆线|住院|休息几天|多久消肿|多久恢复)/, anchors:["恢复", "恢复期", "术后", "拆线", "住院", "消肿"] },
  { pattern:/(?:价格|报价|多少钱|费用|收费|预算|活动|优惠|套餐|权益)/, anchors:["价格", "报价", "费用", "收费", "预算", "活动", "优惠", "套餐", "权益"] },
  { pattern:/(?:水滴形?|水滴型|解剖型|圆形|光面|微绒面|绒面|型号|材料|材质|品牌|假体形状)/, anchors:["水滴", "水滴形", "水滴型", "解剖型", "圆形", "光面", "微绒面", "绒面", "型号", "材料", "材质", "品牌", "假体形状"] },
  { pattern:/(?:风险|副作用|并发症|禁忌|安全性|安全吗)/, anchors:["风险", "副作用", "并发症", "禁忌", "安全"] },
  { pattern:/(?:流程|步骤|怎么做|手术方式|麻醉方式|全麻|局麻)/, anchors:["流程", "步骤", "手术方式", "麻醉", "全麻", "局麻"] },
  { pattern:/(?:自然|垂感|垂坠|柔软|挺拔|明显|保守|不夸张)/, anchors:["自然", "垂感", "垂坠", "柔软", "挺拔", "明显", "保守", "不夸张"] },
  { pattern:/(?:擅长|专业方向|资质|职称|排班|出诊|坐诊|在院)/, anchors:["擅长", "专业方向", "资质", "职称", "排班", "出诊", "坐诊", "在院"] }
]);

const graphFacetAnchors = (query, entities, subjectAnchors) => {
  const facets = [...(entities.concerns || [])];
  for (const quoted of entities.quoted_terms || []) {
    const normalized = normalizeGraphText(quoted);
    if (!normalized || subjectAnchors.some((subject) => subject.includes(normalized) || normalized.includes(subject))) continue;
    facets.push(quoted);
  }
  const text = String(query || "").normalize("NFKC").toLowerCase();
  for (const group of GRAPH_FACET_GROUPS) {
    if (group.pattern.test(text)) facets.push(...group.anchors);
  }
  return [...new Set(facets.map(normalizeGraphText).filter((term) => term.length >= 2))];
};

// Only fixed business-taxonomy terms may cross the retrieval-service trust
// boundary. The customer utterance, quoted text and remembered free-form
// context can contain contact details, medical history or other private data;
// they remain local and are used only by deterministic intent recognition.
const graphOutboundFacetAnchors = (query, entities) => {
  const facets = [...(entities.concerns || [])];
  const text = String(query || "").normalize("NFKC").toLowerCase();
  for (const group of GRAPH_FACET_GROUPS) {
    if (group.pattern.test(text)) facets.push(...group.anchors);
  }
  return [...new Set(facets.map(normalizeGraphText).filter((term) => term.length >= 2))];
};

const graphIntentPathPrefixes = (intent = "", explicitPrefixes = []) => {
  if (explicitPrefixes.length) return explicitPrefixes;
  if (intent.startsWith("doctor_")) return ["医生介绍/"];
  if (intent === "product_attribute_verification") return ["项目价格/", "6月份政策/"];
  if (intent === "price_verification") return ["项目价格/"];
  if (intent === "policy_verification") return ["6月份政策/", "荟员升级权益/"];
  return [];
};

// Policy questions often name a month plus a business topic ("6月份皮肤套餐
// 政策") without a project/doctor entity. The deterministic local retrieval
// has already located the exact policy paths, so reuse only their fixed
// catalog segments as outbound anchors. This keeps the query boundary on
// reviewed taxonomy terms and prevents the GraphRAG query from degrading to a
// generic price/benefit phrase.
const graphPolicyAnchors = (query, localResponse) => {
  const anchors = [];
  const month = String(query || "").normalize("NFKC").match(/(\d{1,2})月份/);
  if (month) anchors.push(`${month[1]}月份政策`);
  for (const citation of (localResponse?.output?.citations || []).slice(0, 4)) {
    const segments = String(citation?.source_relative_path || "").split("/").slice(0, -1);
    for (const segment of segments) {
      const normalized = String(segment || "").normalize("NFKC").trim();
      if (normalized.length >= 2
        && normalized.length <= 20
        && /政策|套餐|权益/.test(normalized)
        && /^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9_.+·®™()-]{1,39}$/.test(normalized)) {
        anchors.push(normalized);
      }
    }
  }
  return [...new Set(anchors)].slice(0, 4);
};

export const buildGraphRagQuery = (query, localResponse, _context = {}) => {
  const intent = String(localResponse?.output?.structured_data?.intent || "");
  const structured = localResponse?.output?.structured_data || {};
  const entities = structured.intent_analysis?.entities || {};
  const doctorAnchors = intent.startsWith("doctor_") ? (entities.doctors || []) : [];
  const projectAnchors = [
    ...(entities.projects || []),
    ...(Array.isArray(structured.projects) ? structured.projects : []),
    structured.project
  ];
  const bodyPartAnchors = projectAnchors.some(Boolean) ? [] : (entities.body_parts || []);
  const policyAnchors = intent === "policy_verification" ? graphPolicyAnchors(query, localResponse) : [];
  const currentAnchors = [
    ...projectAnchors,
    ...doctorAnchors,
    ...bodyPartAnchors,
    ...policyAnchors,
    ...graphOutboundFacetAnchors(query, entities),
    ...graphQueryAliases(query)
  ];
  return [...new Set(currentAnchors
    .map((item) => String(item || "").normalize("NFKC").trim())
    .filter((item) => item.length >= 2))].join(" ");
};

export const graphRagParamsForIntent = (intent = "", env = process.env) => {
  let tuning = {};
  try {
    tuning = JSON.parse(env.HUAMEI_GRAPHRAG_TUNING_JSON || "{}");
  } catch {
    tuning = {};
  }
  const key = intent === "doctor_project_verification" ? "doctor_profile" : intent;
  const selected = { ...(tuning.default || {}), ...(tuning[key] || {}) };
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
  };
  return {
    topK:number(selected.top_k ?? selected.topK, 6, 1, 12),
    topKEntities:selected.top_k_entities ?? selected.topKEntities,
    topKRelationships:selected.top_k_relationships ?? selected.topKRelationships,
    maxContextTokens:selected.max_context_tokens ?? selected.maxContextTokens
  };
};

export const graphRagEvidenceOnlyEnabled = (env = process.env) =>
  String(env.HUAMEI_GRAPHRAG_EVIDENCE_ONLY || "true").toLowerCase() !== "false";

const FAST_PLANNING_INTENTS = new Set([
  "project_explanation", "project_comparison", "project_discovery_by_concern",
  "price_verification", "doctor_profile", "doctor_comparison", "policy_verification",
  "product_catalog_detail", "directory_discovery", "appointment_query",
  "doctor_schedule_verification", "conversation_greeting", "conversation_acknowledgement"
]);

// Suggested first-turn questions and short, unambiguous service questions do
// not need a separate planning-model round trip. Multi-turn/ambiguous turns
// still use the planner so pronouns, corrections and deferred intent remain
// grounded in the conversation.
export const shouldUseFastPlanning = ({ message = "", context = {}, risk = null, env = process.env } = {}) => {
  if (String(env.HUAMEI_FAST_PATH_PLANNING || "false").toLowerCase() !== "true") return false;
  if (risk?.decision && risk.decision !== "allow") return false;
  const text = String(message || "").trim();
  if (!text || text.length > 32) return false;
  if ((context.recent_turns || []).length > 0) return false;
  if (/(?:这个|那个|它|上面|刚才|继续|还有|然后|呢|吗|能不能|可不可以|怎么办)/.test(text)) return false;
  const analysis = recognizeAcquisitionIntent(text, {
    context,
    risk:risk || inspectRisk(text),
    knowledgeRecords:loadHuameiKnowledge().records
  });
  return analysis.confidence >= 0.85
    && analysis.clarification_required !== true
    && FAST_PLANNING_INTENTS.has(analysis.primary_intent);
};

export const filterGraphRagEvidenceForResponse = (evidence = [], localResponse, query = "") => {
  const structured = localResponse?.output?.structured_data || {};
  const intent = String(structured.intent || "");
  const entities = structured.intent_analysis?.entities || {};
  const explicitPrefixes = (structured.evidence_constraints?.path_prefixes || [])
    .map((item) => String(item || ""))
    .filter(Boolean);
  const pathPrefixes = graphIntentPathPrefixes(intent, explicitPrefixes);
  const primarySubjectAnchors = [
    ...(entities.projects || []), ...(entities.doctors || []),
    ...(structured.projects || []), structured.project,
    ...graphQueryAliases(query)
  ].map(normalizeGraphText).filter((term) => term.length >= 2);
  const quotedAnchors = (entities.quoted_terms || []).map(normalizeGraphText).filter((term) => term.length >= 2);
  const subjectEntityAnchors = primarySubjectAnchors.length
    ? primarySubjectAnchors
    : quotedAnchors;
  const fallbackAnchors = [
    ...(entities.concerns || []),
    ...graphQueryTerms(query)
  ].map(normalizeGraphText).filter((term) => term.length >= 2);
  const strongAnchors = [...new Set(subjectEntityAnchors)];
  const facetAnchors = graphFacetAnchors(query, entities, strongAnchors);
  const weakAnchors = [...new Set(fallbackAnchors)];
  const doctorEvidenceIntent = intent.startsWith("doctor_");
  if (!strongAnchors.length && !facetAnchors.length && !weakAnchors.length) return [];
  return evidence.filter((item) => {
    const path = String(item.source_relative_path || "");
    if (pathPrefixes.length && !pathPrefixes.some((prefix) => path.startsWith(prefix))) return false;
    const searchable = normalizeGraphText(`${item.title || ""} ${path} ${item.content || ""}`);
    // Project/doctor and question facet are separate hard boundaries.  When a
    // customer asks about one facet of a named project (for example recovery),
    // a price/material record for that same project is still the wrong source.
    // Pure introductions have no facet boundary and may use subject-only hits.
    const subjectMatched = strongAnchors.some((anchor) => searchable.includes(anchor));
    const facetMatched = facetAnchors.some((anchor) => searchable.includes(anchor));
    if (strongAnchors.length) return subjectMatched && (!facetAnchors.length || doctorEvidenceIntent || facetMatched);
    if (facetAnchors.length) return facetMatched;
    return weakAnchors.some((anchor) => searchable.includes(anchor));
  });
};

const attachGraphRagEvidence = (localResponse, graphResult, context, query = "") => {
  if (!graphResult.used || !graphResult.evidence.length) return localResponse;
  const knowledgeVersion = getHuameiKnowledgeStatus(context.tenant_id).version || "";
  const pathPrefixes = (localResponse.output.structured_data?.evidence_constraints?.path_prefixes || [])
    .map((item) => String(item || ""))
    .filter(Boolean);
  const relevantEvidence = filterGraphRagEvidenceForResponse(graphResult.evidence, localResponse, query);
  const admitted = relevantEvidence
    .filter((item) => isKnowledgeRecordAdmitted(item.record_id, context.tenant_id, knowledgeVersion))
    .filter((item) => !pathPrefixes.length || pathPrefixes.some((prefix) => String(item.source_relative_path || "").startsWith(prefix)))
    .slice(0, 6);
  if (!admitted.length) {
    localResponse.guardrails.graphrag_used = false;
    localResponse.guardrails.graphrag_fallback_reason = pathPrefixes.length ? "no_evidence_within_intent_scope" : "no_admitted_evidence";
    return localResponse;
  }
  const graphHits = admitted.map((item) => ({
    knowledge_id:String(item.record_id),
    title:String(item.title || "").slice(0, 160),
    source_relative_path:String(item.source_relative_path || "").slice(0, 500),
    general_information:compactGraphEvidence(item.content),
    requires_verification:Boolean(item.verification_note),
    verification_note:String(item.verification_note || "").slice(0, 500),
    graph_paths:Array.isArray(item.graph_paths) ? item.graph_paths.slice(0, 6).map(String) : [],
    score:Number(item.score) || 0
  }));
  const graphCitations = graphHits.map((item) => ({
    knowledge_id:item.knowledge_id,
    source_record_id:item.knowledge_id,
    title:item.title,
    version:graphResult.indexVersion,
    source_relative_path:item.source_relative_path,
    excerpt:item.general_information.slice(0, 360),
    usage:"consumer_safe_graphrag_context",
    review_status:item.requires_verification ? "需核验" : "已纳入索引",
    requires_verification:item.requires_verification,
    verification_note:item.verification_note
  }));
  localResponse.output.structured_data = {
    ...localResponse.output.structured_data,
    knowledge_hits:[
      ...(localResponse.output.structured_data?.knowledge_hits || []),
      ...graphHits
    ].slice(0, 10),
    graphrag:{
      engine:graphResult.engine,
      index_version:graphResult.indexVersion,
      retrieval_mode:"local",
      evidence_count:graphHits.length,
      graph_entities:graphResult.graphEntities,
      cache_hit:graphResult.cacheHit === true
    }
  };
  localResponse.output.citations = dedupeCitations([...(localResponse.output.citations || []), ...graphCitations]);
  localResponse.guardrails.graphrag_used = true;
  localResponse.guardrails.graphrag_engine = graphResult.engine;
  localResponse.guardrails.graphrag_index_version = graphResult.indexVersion;
  localResponse.guardrails.graphrag_evidence_admitted = graphHits.length;
  return localResponse;
};

// A-011 AC4：连续两次仍无法理解时，承认不确定并给出人工入口，而不是再问一遍。
const CLARIFICATION_ESCALATION_MESSAGE = "抱歉，我可能没有理解您的意思。您可以换个说法，比如想了解的项目，或想改善的部位；也可以回复“转人工”，我为您转接人工顾问继续沟通。";
// 客户已经明确表态（拒绝联系、暂缓、要求人工）时不属于“没听懂”，照常承接不升级。
const isCustomerDirectedTurn = (text = "") =>
  /(?:不要|不用|别|不需要|先不|暂时不|暂不)(?:再)?(?:联系|打扰|回访|跟进)|没空|不着急|以后再说|再说吧|先不考虑|转人工|找人工|真人顾问|人工客服/.test(String(text || ""));
const clarificationEscalationResult = (input, context, intent, conversationState) => ({
  status:"completed",
  message:CLARIFICATION_ESCALATION_MESSAGE,
  structured_data:{
    intent:"need_clarification",
    original_intent:intent || "",
    clarification_streak:Math.max(0, Number(context?.clarification_streak) || 0),
    supported_projects:[...new Set(searchableProjectKnowledge(context?.tenant_id).map((item) => item.project))],
    conversation_state:conversationState,
    next_questions:[CLARIFICATION_ESCALATION_MESSAGE]
  },
  recommended_actions:[
    { type:"request_human_service_verification" },
    { type:"collect_need", fields:["concern", "body_part", "preferred_project"] }
  ],
  handover:{ required:false },
  citations:[]
});

function acquisitionAgent(input, context, intentAnalysis) {
  const intent = intentAnalysis?.primary_intent || "need_clarification";
  const entities = intentAnalysis?.entities || { projects:[], doctors:[], concerns:[] };
  if (entities.resolved_reference === 'two_projects' && entities.projects.length === 2) input = {...input, message:`${entities.projects.join('和')}有什么区别？`};
  const nextQuestion = nextSalesQuestion(context, intent);
  const packageStatus = getHuameiKnowledgeStatus(context.tenant_id);
  const baseConversationState = { known_slots:context.known_slots, summary:context.conversation_summary, turn_index:context.turn_index };
  const resultFromKnowledgeResponse = (response) => {
    const responseIntent = response.intent || intent;
    return {
      status:response.status,
      message:response.message,
      structured_data:{
        intent:responseIntent,
      projects:entities.projects?.length ? entities.projects : context.interests.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean),
      doctors:entities.doctors || [],
      doctor_candidates:response.doctor_candidates || [],
      knowledge_hits:response.evidence.map((item) => ({
        knowledge_id:item.knowledge_id,
        title:item.title,
        source_relative_path:item.source_relative_path,
        general_information:item.excerpt,
        requires_verification:item.requires_verification
      })),
      conversation_state:baseConversationState,
      next_questions:response.next_questions || [nextQuestion],
      knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
    },
      recommended_actions:[
        { type:responseIntent.startsWith("doctor_") || ["price_verification", "policy_verification", "product_attribute_verification", "service_information"].includes(responseIntent) ? "request_human_source_verification" : "continue_need_discovery" },
        { type:"offer_human_consultation", condition:"customer_ready" }
      ],
      handover:{ required:false },
      citations:response.evidence
    };
  };

  if (intent === "consultation_process" || /^(?:了解|介绍一下|介绍)?面诊流程[？?。]?$/.test(input.message.trim())) return {
    status:"completed",
    message:`${context.known_projects.length ? `关于${context.known_projects.join("、")}，` : ""}面诊一般先说明关注项目和希望了解的问题，再由医生结合实际情况进行专业评估，沟通方案、风险与注意事项。具体流程以院方安排为准。${context.known_projects.length ? "" : "您想咨询哪个项目？"}`,
    structured_data:{ intent:"consultation_process", conversation_state:baseConversationState, general_information_only:true, next_questions:context.known_projects.length ? [] : ["您想咨询哪个项目？"] },
    recommended_actions:[{ type:"collect_need", fields:["preferred_project"] }], handover:{ required:false }, citations:[]
  };

  if (intent === "conversation_greeting") {
    const serviceOptions = ["咨询医美项目", "了解面诊流程"];
    return {
      status:"completed",
      message:"您好，我是华美AI获客顾问小美。可以为您介绍医美项目、公开资料和面诊流程。您想先了解哪个项目？",
      structured_data:{ intent, conversation_state:baseConversationState, next_questions:serviceOptions, knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
      recommended_actions:[{ type:"collect_need", fields:["preferred_project"] }],
      handover:{ required:false }, citations:[]
    };
  }

  if (intent === "conversation_acknowledgement") {
    const thanked = /谢谢|感谢/.test(input.message);
    const pausing = /先这样|先看看|考虑一下/.test(input.message);
    return {
      status:"completed",
      message:thanked
        ? "不客气，有问题继续问我就好。"
        : pausing
          ? "好，您先慢慢比较，想继续了解时直接问我。"
          : "好，您接着说。",
      structured_data:{ intent, conversation_state:baseConversationState, next_questions:[], knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
      recommended_actions:[{ type:"wait_for_customer" }],
      handover:{ required:false }, citations:[]
    };
  }

  // “明星产品”“面膜”这类商品问法不是部位咨询。先用已审核的产品
  // 资料确认客户指向，再自然承接产品信息，不能落回泛化的部位追问。
  const catalogResponse = buildStarProductResponse(
    input.message,
    retrieveHuameiKnowledge(input.message, { audience:"public", limit:6, minimumScore:6, tenantId:context.tenant_id }),
    { tenantId:context.tenant_id }
  );
  if (catalogResponse && ["need_clarification", "directory_discovery"].includes(intent)) {
    return resultFromKnowledgeResponse(catalogResponse);
  }

  if (intent === "case_request_restricted") return {
    status:"completed",
    message:"想先看实际案例很正常。顾客照片需要先核验授权，而且不能用别人的效果判断您的情况；我可以先讲对应项目的一般原理。您想看哪个项目？",
    structured_data:{ intent, access_decision:"restricted", next_questions:["您想先了解哪个项目的一般原理或到院流程？"], conversation_state:baseConversationState, knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
    recommended_actions:[{ type:"offer_reviewed_general_information" }, { type:"request_human_consent_verification", condition:"customer_requests_case_material" }],
    handover:{ required:false }, citations:[]
  };

  // A broad goal is not a concrete project or a confirmed concern. Do not
  // present catalogue headings as treatment recommendations or jump to booking.
  const broadRejuvenation = /抗衰(?:老)?|抗初老|年轻化/.test(input.message)
    && /推荐|什么项目|哪些项目|怎么选|想(?:做|了解|咨询)?抗衰|想年轻/.test(input.message)
    && !/(?:热玛吉|热拉提|超声炮|线雕|拉皮|光子|水光|玻尿酸|肉毒|微拉美|医生|院长|多少钱|价格|活动|预约|面诊流程)/.test(input.message);
  const knownConcreteConcern = entities.concerns?.length || /松弛|下垂|皱纹|法令纹|暗沉|色斑|凹陷|眼袋|泪沟/.test(context.profile.concern || '');
  if(broadRejuvenation && !knownConcreteConcern) {
    const question='您最在意的是细纹、松弛下垂，还是肤色暗沉、看起来没精神？';
    // A-016 AC2：知识包里有可公开的抗衰资料时，必须先介绍可了解的方向及区别，
    // 不能只追问客户表现而一点方向都不给；检索不到资料时保持原有追问口径。
    const directionHits = retrieveHuameiKnowledge(input.message, { audience:"public", limit:8, minimumScore:4, tenantId:context.tenant_id }) || [];
    // 目录类记录（华美资料目录：项目介绍 / 皮肤美容科 / 抗衰老 / 4D眼周）取最后一段作为方向名；
    // 项目介绍类记录（热玛吉｜项目介绍）取竖线前的项目名。
    const directionName = (title) => {
      const text = String(title || "");
      const segments = text.split("/").map((part) => part.trim()).filter(Boolean);
      const tail = segments.length ? segments.at(-1) : "";
      const head = text.split(/[｜|]/)[0].trim();
      return (tail && tail.length <= 14 ? tail : head).replace(/^华美资料目录[:：]?/u, "").trim();
    };
    // 检索命中形如 { item, score }：方向名和引用都必须取自 item（记录本体），
    // 否则引用缺少 source_record_id，前台会按“引用必须带来源记录号”拒绝。
    const directionRecords = directionHits.map((hit) => hit?.item).filter(Boolean);
    const directions = [...new Set(directionRecords
      .map((record) => directionName(record?.title))
      .filter((name) => name.length >= 2 && name.length <= 14
        && !/目录|政策|价格|活动|说明|制度|流程|项目介绍|皮肤美容科|抗衰老|全部/.test(name)))]
      .slice(0, 3);
    const introduction = directions.length >= 2
      ? `抗衰可以先从这些方向了解：${directions.join("、")}。它们作用层次和恢复期不一样，具体适不适合要医生面诊确认，我先按您关心的点展开。`
      : '';
    // 引用只保留可公开检索到的院方资料；资料不足时不编造方向，改为明确“需面诊确认”。
    const directionCitations = directionRecords.slice(0, 2).map((record) => ({
      knowledge_id:record.record_id,
      source_record_id:record.record_id,
      title:String(record.title || "").slice(0, 120),
      version:packageStatus.version,
      source_relative_path:record.source_relative_path,
      record_type:record.record_type,
      excerpt:String(record.excerpt || record.summary || "").slice(0, 160)
        || "院方公开资料中的一般项目介绍；具体方案需医生面诊确认。",
      requires_verification:true,
      verification_note:record.verification_note,
      usage:"consumer_safe_general_information"
    }));
    const clarificationNote = introduction ? "" : "具体情况需要医生面诊确认，";
    return {status:'completed',message:`${introduction}${clarificationNote}抗衰涵盖的方向比较多，先明确您想改善的表现，才好介绍相关项目。${question}`,
      structured_data:{intent:'need_clarification',original_intent:intent,understanding_status:'broad_goal_needs_concern',goal:'抗衰',next_questions:[question],conversation_state:baseConversationState},
      recommended_actions:[{type:'collect_need',fields:['concern']}],handover:{required:false},
      citations:directionCitations};
  }

  // Understand the stated concern before retrieving a project list. This only
  // clarifies the user's intended meaning; it does not assess suitability.
  const need = entities.concern_understanding || {};
  const previousUser = [...context.recent_turns].reverse().find(t=>t.role==='user')?.content || '';
  const knownFace = entities.body_parts?.length ? entities.body_parts.includes('面部') : /脸|面部|嘴边肉/.test(previousUser);
  const discoveryTurn = ['need_clarification','project_discovery_by_concern','conversation_followup'].includes(intent) && !entities.projects?.length;
  if(discoveryTurn && (need.ambiguous_appearance || (knownFace && (need.non_surgical_preference || /不是这个意思|你没理解|理解错了/.test(input.message))))) {
    const question = need.ambiguous_appearance
      ? /垮/.test(input.message) ? '您说的“垮”更接近轮廓往下走，还是脸颊不够饱满、看起来疲惫？' : '您说的疲惫感，更接近肤色暗一些，还是脸颊不够饱满？'
      : need.non_surgical_preference
        ? context.profile.concern
          ? '您更想先了解一般原理，还是恢复安排？'
          : '您想改善的观感更接近轮廓松下来，还是脸颊凹、显得疲惫？'
        : '是我把您说的哪一点理解错了？';
    const acknowledgement = need.non_surgical_preference
      ? `记住了，您暂时不考虑手术。我们继续围绕${context.profile.concern||'面部观感'}了解非手术方向，具体是否适合再由医生面诊确认。`
      : need.ambiguous_appearance
        ? /垮/.test(input.message)
          ? '您想改善脸部显得松垮的感觉。先分清您说的“垮”是什么样子，再聊项目方向。'
          : '您在意的是脸部看起来疲惫、没精神。先确认您指的观感，再聊项目方向。'
        : '抱歉，我先停下刚才的判断，不继续按那个方向推荐。';
    return {status:'completed',message:acknowledgement+question,
      structured_data:{intent:'need_clarification',original_intent:intent,concerns:entities.concerns||[],body_parts:knownFace?['面部']:entities.body_parts||[],understanding_status:'needs_confirmation',next_questions:[question],conversation_state:baseConversationState},
      recommended_actions:[{type:'collect_need',fields:['appearance_goal']}],handover:{required:false},citations:[]};
  }
  if (KNOWLEDGE_BOUND_INTENTS.has(intent) && !packageStatus.admission?.ready) {
    return {
      status:"handover_required",
      message:"这项信息目前无法完成可靠核验。为避免给您不准确的答复，需要由人工顾问继续确认。",
      structured_data:{
        intent,
        projects:entities.projects || [],
        doctors:entities.doctors || [],
        next_questions:[],
        conversation_state:baseConversationState,
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded, admitted:false }
      },
      recommended_actions:[{ type:"request_human_source_verification" }],
      handover:{ required:true, to_team:"在线咨询", reason:"knowledge_integrity_not_ready" },
      citations:[]
    };
  }

  const specializedBirthmarkConcern = (entities.concerns || []).find((concern) => /(?:胎记|太田痣|鲜红斑痣|雀斑样痣|咖啡斑|血管瘤)/.test(concern));
  const moleConcern = specializedBirthmarkConcern
    ? null
    : (entities.concerns || []).find((concern) => /(?:色素痣|黑痣|^痣$)/.test(concern));
  if (moleConcern) {
    const sourceHit = retrieveHuameiKnowledge("点痣 CO2激光 色素痣 黑痣", {
      audience:"public",
      limit:3,
      tenantId:context.tenant_id,
      pathPrefixes:["项目介绍/皮肤美容科/点痣/"]
    });
    const evidence = sourceHit.map((hit) => publicEvidenceFor(hit, input.message)).filter(Boolean);
    const largeArea = /(?:很大|比较大|大面积|一大片|面积[^，。；]{0,4}大)/.test(input.message);
    const faceConcern = /(?:脸|面部|额头|眉|眼|鼻|嘴|唇|下巴|颧)/.test(input.message);
    const acknowledgement = faceConcern
      ? largeArea ? "脸上一块面积比较大的痣" : "脸上的痣"
      : largeArea ? "一块面积比较大的痣" : "您提到的痣";
    const question = "您更想先了解面诊评估流程，还是到院前准备？";
    return {
      status:"completed",
      message:`知道了，是${acknowledgement}。院方资料有CO₂激光点痣的一般介绍。面积较大时，不能只凭文字确定处理方式，需要医生先看类型、深度和位置。${question}`,
      structured_data:{
        intent:"project_discovery_by_concern",
        concerns:entities.concerns || [moleConcern],
        body_parts:entities.body_parts || [],
        knowledge_hits:evidence.map((item) => ({ knowledge_id:item.knowledge_id, title:item.title, source_relative_path:item.source_relative_path, general_information:item.excerpt, requires_verification:item.requires_verification })),
        evidence_constraints:{ path_prefixes:["项目介绍/皮肤美容科/点痣/"] },
        conversation_state:baseConversationState,
        next_questions:[question],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"collect_need", fields:["mole_location", "mole_size"] }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:evidence
    };
  }

  const birthmarkConcern = specializedBirthmarkConcern;
  if (birthmarkConcern) {
    const sourceHit = retrieveHuameiKnowledge("太田痣 鲜红斑痣 雀斑样痣 咖啡斑 胎记", {
      audience:"public",
      pathPrefixes:["项目价格/皮肤美容科/病症系列/"],
      minimumScore:6,
      limit:1,
      tenantId:context.tenant_id
    })[0]?.item;
    const evidence = sourceHit ? [{
      knowledge_id:sourceHit.record_id,
      source_record_id:sourceHit.record_id,
      title:"皮肤美容科｜病症系列（胎记相关）",
      version:packageStatus.version,
      source_relative_path:sourceHit.source_relative_path,
      record_type:sourceHit.record_type,
      excerpt:"院方资料将胎记相关咨询归入皮肤美容科病症系列，涉及太田痣、鲜红斑痣、雀斑样痣、咖啡斑等分类；具体类别需由医生面诊判断。",
      requires_verification:true,
      verification_note:sourceHit.verification_note,
      usage:"consumer_safe_general_information",
      review_status:"需核验"
    }] : [];
    const faceConcern = entities.body_parts?.includes("面部");
    const largeArea = /(?:很大|比较大|大面积|一大片|面积[^，。；]{0,4}大)/.test(input.message);
    const concernLabel = birthmarkConcern === "胎记" ? "胎记" : birthmarkConcern;
    const acknowledgement = faceConcern
      ? largeArea ? `脸上一块面积比较大的${concernLabel}` : `脸上的${concernLabel}`
      : largeArea ? `一块面积比较大的${concernLabel}` : `您提到的${concernLabel}`;
    const question = birthmarkConcern === "胎记"
      ? "这块胎记大致是青褐色、红色，还是咖啡色？"
      : "您更想先了解面诊评估流程，还是到院前需要准备什么？";
    return {
      status:"completed",
      message:`知道了，是${acknowledgement}。胎记有不同类型，院方资料涉及太田痣、鲜红斑痣、雀斑样痣、咖啡斑等。先由皮肤科医生面诊分型，再确定后续处理方向，不能只凭文字判断具体类型。${question}`,
      structured_data:{
        intent:"project_discovery_by_concern",
        concerns:entities.concerns || [birthmarkConcern],
        body_parts:entities.body_parts || [],
        knowledge_hits:evidence.map((item) => ({ knowledge_id:item.knowledge_id, title:item.title, source_relative_path:item.source_relative_path, general_information:item.excerpt, requires_verification:item.requires_verification })),
        evidence_constraints:{ path_prefixes:["项目价格/皮肤美容科/病症系列/"] },
        conversation_state:baseConversationState,
        next_questions:[question],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"collect_need", fields:["birthmark_color"] }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:evidence
    };
  }

  if (intentAnalysis?.clarification_required) {
    // A-025 AC1：图片通道未启用时明确说明不支持，不留下无效上传入口。
    const imageUploadRequest = /(?:上传|发送|发|传)[^。，,！？?]{0,8}(?:照片|图片|图像)/.test(input.message);
    if (imageUploadRequest) {
      const unsupported = "当前在线咨询暂不支持上传图片（图片通道未启用）。您可以把关注点或想了解的项目告诉我，我先介绍一般资料；也可以转人工顾问，安排到院由医生查看具体情况。";
      return {
        status:"completed",
        message:unsupported,
        structured_data:{
          intent:"image_channel_unsupported",
          projects:[...(context.known_projects || [])],
          next_questions:[],
          conversation_state:baseConversationState,
          supported_projects:[...new Set(searchableProjectKnowledge(context.tenant_id).map((item) => item.project))]
        },
        recommended_actions:[{ type:"request_human_service_verification" }],
        handover:{ required:false },
        citations:[]
      };
    }
    // 连续两次都没听懂：不再重复同一个澄清问题，改为承认不确定并给出人工入口。
    if (Number(context.clarification_streak) >= 1 && !isCustomerDirectedTurn(input.message)) return clarificationEscalationResult(input, context, intent, baseConversationState);
    const message = intent === "doctor_discovery_by_project"
      ? "我先按项目方向帮您缩小医生范围。您主要想咨询眼部、鼻部、胸部，还是面部年轻化？"
      : entities.concerns?.length
        ? `您提到的是${entities.concerns.join('、')}。您想先了解相关项目的一般区别，还是面诊流程？`
        : entities.body_parts?.length
          ? `您想了解${entities.body_parts.join('、')}的改善方向。具体是外观上的哪一点让您在意？`
          : context.profile.concern
            ? `我们接着聊您在意的${context.profile.concern}。您这次想进一步了解哪一点？`
            : "您最想改善的是什么，或者有想了解的项目吗？";
    return {
      status:"completed", message,
      structured_data:{ intent:"need_clarification", original_intent:intent, supported_projects:[...new Set(searchableProjectKnowledge(context.tenant_id).map((item) => item.project))], conversation_state:baseConversationState, next_questions:[message], knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
      recommended_actions:[{ type:"collect_need", fields:["concern", "body_part", "preferred_project"] }],
      handover:{ required:false }, citations:[]
    };
  }

  if (["appointment_query", "appointment_request"].includes(intent)) {
    const explicitRequest = intent === "appointment_request";
    const appointmentProjects = (entities.projects?.length ? entities.projects : context.known_projects).slice(0, 3);
    const projectText = appointmentProjects.length ? appointmentProjects.join("、") : "您关注项目";
    return {
      status:"completed",
      message:explicitRequest
        ? `您可以在下方确认${projectText}的期望到院日期和时段。确认后系统会保存登记，顾问后续跟进；此登记不锁定指定医生或接诊名额。`
        : `可以登记您期望的到院时间，顾问后续跟进安排。${appointmentProjects.length ? `您关注的是${projectText}，${context.presales_state?.visit_preference ? '具体接诊时间还需要确认。' : '您更方便哪天到院？'}` : '您想咨询哪个项目或哪位医生？'}`,
      structured_data:{ intent, projects:appointmentProjects, conversation_state:baseConversationState, next_questions:["您更方便哪一天、上午还是下午？"], knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
      recommended_actions:[{ type:"collect_appointment_preference", fields:["preferred_project", "preferred_date", "time_preference"] }, ...(explicitRequest ? [{ type:"offer_human_appointment" }] : [])],
      handover:{ required:false }, citations:[]
    };
  }

  const resolvedChoice = intentAnalysis?.choice_resolution?.status === "selected"
    ? intentAnalysis.choice_resolution.selection
    : null;
  const currentExplicitProjects = explicitProjectIntents(input.message);
  const switchedAwayFromBreast = currentExplicitProjects.some((item) => !/(?:胸|乳房)/.test(item.project));
  const breastType = normalizeBreastMethod(resolvedChoice?.breast_method)
    || selectedBreastProjectType(input.message)
    || (!switchedAwayFromBreast ? normalizeBreastMethod(context.known_slots?.breast_method) : null);
  const activeBreastProject = breastProjectForMethod(breastType);
  // 追问常常只会写“这是什么原理”。把会话中已确认的具体项目拼入检索词，
  // 让检索稳定命中内部的自体脂肪/假体项目资料，而不是按泛意图猜项目。
  const correctingMethod = intentAnalysis?.choice_resolution?.matched_by === "explicit_correction";
  const projectRetrievalQuery = need.negated_concerns?.length && entities.concerns?.length ? entities.concerns.join(' ')
    : correctingMethod ? activeBreastProject
    : currentExplicitProjects.length ? input.message
    : [input.message, ...(entities.projects || []), ...(entities.concerns || []), activeBreastProject].filter(Boolean).join(" ");
  const hits = retrieveProjectKnowledge(projectRetrievalQuery, need.negated_concerns?.length ? {...context,interests:[]} : context, 3);
  const rememberedProjects = [...new Set([
    ...context.interests.map((item) => typeof item === "string" ? item : item?.name),
    ...context.known_projects,
    activeBreastProject
  ].filter(Boolean))];
  const knowledgeQuery = [projectRetrievalQuery, ...hits.map(({ item }) => item.project), ...rememberedProjects.slice(0, 5)].join(" ");

  const principleFollowup = entities.requested_facet === 'principle' || ['project_explanation','conversation_followup'].includes(intent) && /一般原理|作用原理|什么原理|的原理|怎么起作用/.test(input.message);
  if(principleFollowup && !breastType && hits.length) {
    const item=hits[0].item;
    const principle=compactKnowledgeText(item.introduction||item.excerpt,500).split(/(?<=[。])/).slice(0,2).join('').trim();
    if(principle) return {
      status:'completed',message:`我们接着说${item.project}的原理。${principle}`,
      structured_data:{intent:'conversation_followup',project:item.project,projects:[item.project],requested_facet:'principle',next_questions:[],conversation_state:baseConversationState,knowledge_hits:[{knowledge_id:item.id,project:item.project,general_information:safeProjectSummary(item)}]},
      recommended_actions:[],handover:{required:false},citations:[citation(item.project,item)]
    };
  }
  // 客户在已知项目下追问感受、恢复或风险时，必须接着这个项目回答，而不是
  // 落回“您主要在意的是……”这类占位承接，也不能把资料原文当结论。这些
  // 回答只说需要面诊确认的边界，不替医生判断个体情况。
  const followupItem = hits[0]?.item;
  const followupFacet = followupItem && !breastType && !currentExplicitProjects.length && rememberedProjects.length
    ? [
        { key:"comfort", pattern:/(?:痛|疼|麻药|麻醉|舒适|难受|感觉)/, message:`${followupItem.project}的治疗感受和是否需要麻药，会因治疗部位与具体方案不同，需要医生在面诊时结合您的情况说明。` },
        { key:"recovery", pattern:/(?:恢复|休息|消肿|肿胀|几天|多久|上班|请假|停工期)/, message:`${followupItem.project}的恢复安排需要按具体方案确认，一般会关注护理要求和按时复诊；如果出现明显或持续不适，请及时联系院方。` },
        { key:"safety", pattern:/(?:风险|副作用|安全|危害|并发症|后遗症)/, message:`${followupItem.project}的适用性、禁忌和风险需要医生面诊评估，这里不做个体判断；需要的话我可以帮您转人工顾问。` }
      ].find((entry) => entry.pattern.test(input.message))
    : null;
  if (followupFacet) return {
    status:'completed',
    message:followupFacet.message,
    structured_data:{
      intent:'conversation_followup',
      project:followupItem.project,
      projects:[followupItem.project],
      requested_facet:followupFacet.key,
      next_questions:[],
      conversation_state:baseConversationState,
      knowledge_hits:[{ knowledge_id:followupItem.id, project:followupItem.project, general_information:safeProjectSummary(followupItem) }]
    },
    recommended_actions:[],
    handover:{ required:false },
    citations:[citation(followupItem.project, followupItem)]
  };
  const confirmedBreastMethod = breastType;
  const breastPrincipleFollowup = intent === "project_explanation"
    && Boolean(breastType)
    && (resolvedChoice?.facet === "general_principle" || /(?:原理|是什么|怎么做|流程|步骤)/.test(input.message));
  if (breastPrincipleFollowup) {
    const project = activeBreastProject || hits[0]?.item?.project || "胸部整形";
    const source = hits.find(({ item }) => item.project === project)?.item || hits[0]?.item;
    const question = "您接下来更想了解恢复安排，还是一般流程？";
    return {
      status:"completed",
      message:`${breastPrincipleMessage(breastType)}${question}`,
      structured_data:{
        intent,
        project,
        projects:[project],
        breast_method:breastType,
        facet:"general_principle",
        knowledge_hits:source ? [{ knowledge_id:source.id, project:source.project, title:source.cardTitle, general_information:safeProjectSummary(source) }] : [],
        conversation_state:baseConversationState,
        next_questions:[question],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"continue_project_education", fields:["recovery_or_general_process"] }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:source ? [citation(source.project, source)] : []
    };
  }
  const implantShapeFollowup = intent === "conversation_followup"
    && confirmedBreastMethod === "implant"
    && (resolvedChoice?.facet === "implant_shape" || /(?:假体)?形态|有哪些形态|什么形态|圆形|水滴形|水滴型|解剖型/.test(input.message));
  if (implantShapeFollowup) {
    const question = "您更在意自然感，还是上胸饱满度？";
    return {
      status:"completed",
      message:`假体常见会按圆形和水滴形两类介绍，水滴形也常称解剖型。圆形的上部轮廓通常更饱满；水滴形的外观通常更接近上薄下厚。具体可用的形态与型号，以院方当前产品和医生面诊评估为准。${question}`,
      structured_data:{
        intent,
        project:"胸部整形",
        projects:["胸部整形"],
        breast_method:"implant",
        facet:"implant_shape",
        knowledge_hits:hits.slice(0, 2).map(({ item }) => ({ knowledge_id:item.id, project:item.project, title:item.cardTitle, general_information:safeProjectSummary(item) })),
        conversation_state:baseConversationState,
        next_questions:[question],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"collect_shape_preference", fields:["style_preference"] }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:dedupeCitations(hits.slice(0, 2).map(({ item }) => citation(item.project, item)))
    };
  }
  const recoveryFollowup = intent === "conversation_followup"
    && (resolvedChoice?.facet === "recovery" || /(?:恢复期?|术后|消肿|拆线|住院|休息几天|请假几天|多久(?:恢复|消肿|能上班|能工作|能运动))/.test(input.message))
    && rememberedProjects.length;
  if (recoveryFollowup) {
    const project = hits[0]?.item?.project || rememberedProjects[0];
    const projectCitation = hits[0]?.item ? [citation(hits[0].item.project, hits[0].item)] : [];
    const question = "您更关心多久能正常上班，还是多久能恢复运动？";
    return {
      status:"completed",
      message:`您问的是${project}的恢复安排。具体时间会受项目方式和个人情况影响，不能只按一个固定天数判断。一般要按医生要求护理、复诊，再逐步恢复日常活动。${question}`,
      structured_data:{
        intent,
        project,
        projects:[project],
        recovery_information_requires_plan_verification:true,
        knowledge_hits:hits.slice(0, 2).map(({ item }) => ({ knowledge_id:item.id, project:item.project, title:item.cardTitle, general_information:safeProjectSummary(item) })),
        conversation_state:baseConversationState,
        next_questions:[question],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"collect_recovery_priority", fields:["return_to_work", "return_to_exercise"] }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:projectCitation
    };
  }

  const breastPreferenceFollowup = intent === "conversation_followup"
    && /(?:自然|垂感|垂坠|柔软|挺拔)/.test(input.message)
    && [...context.known_projects, ...rememberedProjects].some((project) => /(?:胸|隆胸|丰胸|自体脂肪)/.test(project));
  if (breastPreferenceFollowup) {
    const preference = [/(?:自然)/.test(input.message) ? "自然感" : "", /(?:垂感|垂坠)/.test(input.message) ? "轻微垂感" : ""].filter(Boolean).join("和") || "形态偏好";
    return {
      status:"completed",
      message:`您偏好的${preference}，我记住了。胸部项目里，假体与自体脂肪在支撑、触感和形态上各有侧重。具体方案由医生面诊确认。您想先比较两种方式，还是先看恢复安排？`,
      structured_data:{
        intent,
        projects:rememberedProjects,
        knowledge_hits:hits.map(({ item }) => ({ knowledge_id:item.id, project:item.project, title:item.cardTitle, general_information:safeProjectSummary(item) })),
        conversation_state:baseConversationState,
        next_questions:["您想先比较假体与自体脂肪，还是先看恢复安排？"],
        knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
      },
      recommended_actions:[{ type:"continue_preference_comparison" }, { type:"offer_human_consultation", condition:"customer_ready" }],
      handover:{ required:false },
      citations:dedupeCitations(hits.map(({ item }) => citation(item.project, item)))
    };
  }

  const priorDoctorSearch = context.last_intent === "doctor_discovery_by_project"
    || context.recent_turns.some((turn) => turn.role === "user" && isDoctorRecommendationIntent(turn.content));
  if (breastType && priorDoctorSearch) {
    const doctorQuery = breastType === "implant" ? "假体隆胸推荐哪个医生" : "自体脂肪隆胸推荐哪个医生";
    const doctorResponse = buildDoctorRecommendationResponse(doctorQuery, retrieveDoctorKnowledge(doctorQuery, { limit:4, tenantId:context.tenant_id }));
    if (doctorResponse?.doctor_candidates?.length) {
      const names = doctorResponse.doctor_candidates.map((candidate) => `${candidate.name}院长`).join("、");
      const typeLabel = breastType === "implant" ? "假体丰胸" : "自体脂肪丰胸";
      doctorResponse.message = `您确定的是${typeLabel}方向。目前可继续核验的相关医生有：${names}。正式擅长范围和近期排班以院方最新信息为准。您想先看哪位医生的介绍？`;
      doctorResponse.next_questions = ["您想先看哪位医生的介绍？"];
      return resultFromKnowledgeResponse(doctorResponse);
    }
  }

  if (intent === "doctor_discovery_by_project") {
    const doctorResponse = buildDoctorRecommendationResponse(input.message, retrieveDoctorKnowledge(input.message, { limit:4, tenantId:context.tenant_id }));
    if (doctorResponse) return resultFromKnowledgeResponse(doctorResponse);
    return {
      status:"completed",
      message:"明白，您是想按项目找医生。目前可核验的信息还不足以给出可靠候选，我不想仅凭姓名做推荐。需要人工顾问按最新资质、正式擅长和排班继续核验吗？",
      structured_data:{ intent, projects:entities.projects || [], next_questions:["需要人工顾问按这个项目方向继续核验吗？"], conversation_state:baseConversationState, knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
      recommended_actions:[{ type:"request_human_source_verification" }], handover:{ required:false }, citations:[]
    };
  }

  if (intent === "doctor_comparison") {
    const response = buildDoctorComparisonResponse(input.message, entities.doctors || [], retrieveNamedDoctorProfiles(entities.doctors || [], { limitPerDoctor:2, tenantId:context.tenant_id }));
    if (response) return resultFromKnowledgeResponse(response);
  }

  if (entities.doctors?.length && /(?:有哪些项目|擅长(?:哪些|什么)|能做(?:哪些|什么)项目)/.test(input.message)) return {
    status:"completed",
    message:`我先按已发布的医生资料核验${entities.doctors.join("、")}的公开项目方向，不能仅凭目录或姓名推断个体适用性。`,
    structured_data:{
      intent:"doctor_project_verification",
      doctors:entities.doctors,
      projects:entities.projects || [],
      next_questions:[],
      evidence_plan:{ path_prefixes:["医生介绍/"], require_doctor_evidence:true },
      knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
    },
    recommended_actions:[{ type:"verify_doctor_project_relations", fields:["doctors", "projects"] }],
    handover:{ required:false }, citations:[]
  };

  if (["doctor_profile", "doctor_schedule_verification"].includes(intent)) {
    const namedHits = retrieveNamedDoctorProfiles(entities.doctors || [], {
      limitPerDoctor:3,
      tenantId:context.tenant_id,
      query:input.message
    });
    const response = buildPublicKnowledgeResponse(input.message, namedHits.length ? namedHits : retrieveHuameiKnowledge(knowledgeQuery, { audience:"public", limit:5, tenantId:context.tenant_id }));
    if (response) {
      if (intent === "doctor_schedule_verification") {
        const names = entities.doctors || [];
        response.intent = intent;
        response.message = `${names.length ? `${names.map((name) => `${name}院长`).join("、")}有相关介绍` : "目前有相关医生介绍"}，但近期排班需要实时确认。您想查哪一天？`;
        response.next_questions = ["您想查哪一天、上午还是下午？"];
      } else if (intent === "doctor_profile" && /(?:丰胸|隆胸|胸部)/.test(input.message) && entities.doctors?.length) {
        const names = entities.doctors.map((name) => `${name}院长`).join("、");
        response.intent = intent;
        response.message = `${names}的胸部整形公开资料已为您发送。相关资料会涉及假体和自体脂肪等方向，正式擅长范围和近期排班以院方最新信息为准。您想先了解假体丰胸，还是自体脂肪丰胸？`;
        response.next_questions = ["您想先了解假体丰胸，还是自体脂肪丰胸？"];
      }
      return resultFromKnowledgeResponse(response);
    }
  }

  const routePathPrefixes = intent === "price_verification"
    ? ["项目价格/"]
    : intent === "product_attribute_verification"
      ? ["项目价格/", "6月份政策/"]
    : intent === "policy_verification"
      ? ["6月份政策/", "荟员升级权益/"]
      : [];
  const huameiHits = retrieveHuameiKnowledge(knowledgeQuery, {
    audience:"public",
    limit:5,
    tenantId:context.tenant_id,
    ...(routePathPrefixes.length ? { pathPrefixes:routePathPrefixes } : {}),
    ...(intent === "product_attribute_verification" ? { minimumScore:6 } : {})
  });
  if (intent === "product_attribute_verification") {
    const attributeResponse = buildProductAttributeResponse(input.message, huameiHits);
    if (attributeResponse) return resultFromKnowledgeResponse(attributeResponse);
  }
  const responseEvidenceQuery = intent === "price_verification"
    ? `${input.message} 价格 报价 费用 当前核验`
    : intent === "policy_verification"
      ? `${input.message} 活动 政策 优惠 当前核验`
      : input.message;
  const serviceSubject = /地址|怎么走|位置|路线|院区/.test(input.message) ? '到院地址和路线' : /停车/.test(input.message) ? '停车安排' : /营业|几点|开门/.test(input.message) ? '营业时间' : /电话/.test(input.message) ? '院方联系电话' : '';
  const serviceUnknown = serviceSubject ? `${serviceSubject}需要按院方当前信息核实，我这里暂时没有可确认的资料。` : '您想了解地址、停车、营业时间还是联系电话？';
  const huameiResponse = buildPublicKnowledgeResponse(responseEvidenceQuery, huameiHits);
  if (["directory_discovery", "service_information", "price_verification", "policy_verification"].includes(intent) && huameiResponse) {
    huameiResponse.intent = intent;
    // 一条消息里同时问了项目知识和价格/政策时，先答知识再答价格；不能因为
    // 路由到价格意图就丢掉同一轮里的项目问题。
    const alsoAsksExplanation = /(?:原理|作用|是什么|怎么做|介绍|了解一下|有啥区别|区别)/.test(input.message);
    if (alsoAsksExplanation && hits.length && !huameiResponse.message.startsWith(customerProjectSummary(hits[0].item).slice(0, 6))) {
      const explanation = customerProjectSummary(hits[0].item);
      if (explanation) {
        huameiResponse.message = `${explanation} ${huameiResponse.message}`;
        // 项目解释类引用放在最前：它直接支撑本轮的知识点，价格/政策引用排在其后。
        huameiResponse.evidence = [citation(hits[0].item.project, hits[0].item), ...(huameiResponse.evidence || [])].filter(Boolean);
      }
    }
    if (intent === "service_information" && !/(?:地址|停车|营业|电话|院区)/.test(huameiResponse.message)) {
      huameiResponse.message = serviceUnknown;
      huameiResponse.next_questions = serviceSubject ? [] : [serviceUnknown];
      huameiResponse.evidence = [];
    }
    return resultFromKnowledgeResponse(huameiResponse);
  }

  if (intent === "service_information") return {
    status:"completed",
    message:serviceUnknown,
    structured_data:{ intent, next_questions:serviceSubject ? [] : [serviceUnknown], conversation_state:baseConversationState, knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
    recommended_actions:[{ type:"request_human_service_verification" }], handover:{ required:false }, citations:[]
  };

  if (!hits.length && huameiResponse) return resultFromKnowledgeResponse({ ...huameiResponse, intent });
  // 只有“本轮同样是需要澄清”时才升级；拒绝联系、人工请求等确定性轮次照常承接。
  if (!hits.length && Number(context.clarification_streak) >= 1 && !isCustomerDirectedTurn(input.message)
    && (intent === "need_clarification" || intentAnalysis?.clarification_required === true)) {
    return clarificationEscalationResult(input, context, intent, baseConversationState);
  }
  if (!hits.length) return {
    status: "completed",
    message: entities.concerns?.length
      ? `您在意的是${entities.concerns.join('、')}。目前还没有足够匹配的信息让我可靠地介绍具体项目。您想先了解面诊评估流程，还是请人工顾问继续核实相关资料？`
      : entities.body_parts?.length
        ? `您提到了${entities.body_parts.join('、')}。具体想改善外观上的哪一点？`
        : "您最想改善的是什么，或者有想了解的项目吗？",
    structured_data: { intent: "need_clarification", original_intent:intent, supported_projects: [...new Set(searchableProjectKnowledge(context.tenant_id).map((item) => item.project))], conversation_state:baseConversationState, next_questions:[nextQuestion], knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded } },
    recommended_actions: [{ type: "collect_need", fields: ["concern", "body_part", "preferred_project", "contact_preference"] }],
    handover: { required: false }, citations: []
  };
  const knowledgeHits = hits.map(({ item }) => ({
    knowledge_id: item.id,
    project: item.project,
    title: item.cardTitle,
    parts: item.parts || [],
    efficacy_labels: (item.efficacyLabels || []).slice(0, 5),
    general_information: safeProjectSummary(item)
  }));
  const primary = hits[0].item;
  const normalizedMessage = String(input.message).toLowerCase();
  const explicitHits = hits.filter(({ item, matchType }) => matchType === "explicit" || explicitProjectTerms(item).some((term) => normalizedMessage.includes(term.toLowerCase())));
  const exactProject = explicitHits.length > 0;
  const comparisonLabel = (item) => currentExplicitProjects.find((match) => match.recordId === item.id)?.alias || item.project;
  const breastProjectRequest = intent === "project_explanation"
    && !breastType
    && /(?:丰胸|隆胸|胸部整形|乳房整形)/.test(input.message)
    && hits.some(({ item }) => /(?:丰胸|隆胸|胸部整形)/.test(`${item.project} ${item.cardTitle}`));
  const breastRecoveryRequest = Boolean(breastType) && /(?:恢复期?|术后|消肿|拆线|住院|休息几天|请假几天|多久(?:恢复|消肿|能上班|能工作|能运动)|注意)/.test(input.message);
  const projectNextQuestion = breastType === "implant"
    ? breastRecoveryRequest
      ? "您更关心多久能恢复日常活动，还是复诊安排？"
      : "您更想先了解假体形态，还是恢复安排？"
    : breastType === "fat"
      ? breastRecoveryRequest
        ? "您更关心多久能恢复日常活动，还是复诊安排？"
        : "您更想先了解一般原理，还是恢复安排？"
      : breastProjectRequest
        ? "您想先了解假体隆胸，还是自体脂肪隆胸？"
    : nextQuestion;
  let message = breastRecoveryRequest
    ? `${breastType === "implant" ? "假体丰胸" : "自体脂肪丰胸"}后的恢复安排，需要按具体方式和面诊后的医嘱确认。一般会关注伤口护理、按时复诊，并循序恢复日常活动；如果出现明显或持续不适，应及时联系院方。`
    : breastType
    ? selectedBreastProjectSummary(breastType)
    : breastProjectRequest
      ? breastProjectSummary()
    : explicitHits.length >= 2
    ? `先按资料比较${explicitHits.map(({ item }) => comparisonLabel(item)).join("和")}：${explicitHits.map(({ item }) => `${comparisonLabel(item)}：${shortProjectSummary(item)}`).join("；")}。具体包含范围、材料和恢复安排仍需面诊核实。`
    : exactProject
      ? `${customerProjectSummary(primary)} 具体方案由医生面诊确认。`
      // 客户没说明主诉时不能回“当前改善问题”这类占位词；先承接再给方向。
      : `${entities.concerns?.length ? `明白，您主要在意的是${entities.concerns.join("、")}。` : "好的。"}可以先看这些方向：${hits.map(({ item }) => `${item.project}（${(item.efficacyLabels || []).slice(0, 3).join("、") || "一般项目介绍"}）`).join("；")}。具体选择再由医生面诊确认。`;
  if (PRICE_OR_POLICY_INTENT.test(input.message)) {
    message += " 价格或活动我可以继续帮您核验，但不把历史图片直接当当前报价；需要确认包含项、有效期和限制条件。";
  }
  if (!/[？?]/.test(message)) message += projectNextQuestion;
  const requiresSourcePackage = PRICE_OR_POLICY_INTENT.test(input.message) || /(?:医生|院长|专家|资质|排班|会员|荟员|权益)/.test(input.message);
  const huameiEvidence = requiresSourcePackage
    ? (huameiResponse?.evidence || huameiHits.map((hit) => publicEvidenceFor(hit, input.message)).filter(Boolean))
    : [];
  const citations = dedupeCitations([
    ...hits.map(({ item }) => citation(item.project, item)),
    ...huameiEvidence
  ]);
  return {
    status: "completed", message,
    structured_data: {
      intent,
      project: primary.project,
      compared_entities:explicitHits.length >= 2 ? explicitHits.map(({ item }) => ({ name:comparisonLabel(item), source_record_id:item.id })) : [],
      projects: explicitHits.map(({ item }) => item.project),
      knowledge_hits:[
        ...knowledgeHits,
        ...huameiEvidence.map((item) => ({ knowledge_id:item.knowledge_id, title:item.title, source_relative_path:item.source_relative_path, general_information:item.excerpt, requires_verification:item.requires_verification }))
      ].slice(0, 8),
      conversation_state:{ known_slots:context.known_slots, summary:context.conversation_summary, turn_index:context.turn_index },
      next_questions:[projectNextQuestion],
      knowledge_package:{ version:packageStatus.version, loaded:packageStatus.loaded }
    },
    recommended_actions:[
      { type: "update_interest", project: primary.project },
      ...(PRICE_OR_POLICY_INTENT.test(input.message) ? [{ type:"request_human_source_verification", fields:["current_price", "included_items", "validity", "restrictions"] }] : []),
      { type: "offer_human_consultation", condition: "customer_ready" }
    ],
    handover: { required: false }, citations
  };
}

function appointmentAgent(input, context) {
  if (input.mode === "outbound" && !context.marketing_consent) return {
    status: "blocked", message: "当前没有有效营销触达授权，本次邀约不会发送。可保留为内部人工建议，待授权有效后再触达。",
    structured_data: { consent: "marketing_consent_missing" }, recommended_actions: [{ type: "wait_for_consent" }], handover: { required: false }, citations: []
  };
  const slots = context.available_slots;
  if (!slots.length) return {
    status: input.mode === "outbound" ? "approval_required" : "handover_required",
    message: "可以先记录您方便到院的日期偏好。当前没有经过排班系统确认的可约时段，需要由人工顾问实时核实。您更方便工作日还是周末？",
    structured_data: {
      intent:"appointment",
      proposed_slots:[],
      schedule_verification:"human_realtime_required",
      consent_checked:true
    },
    recommended_actions:[
      { type:"collect_date_preference" },
      { type:"request_human_schedule_verification" }
    ],
    handover:{ required:true, to_team:"在线咨询", reason:"live_schedule_evidence_missing" },
    citations:[]
  };
  return {
    status: input.mode === "outbound" ? "approval_required" : "completed",
    message: `可以先为您安排到院评估。目前可选时段包括${slots.slice(0, 3).join("、")}。您更方便工作日还是周末？具体项目安排以到院评估结果为准。`,
    structured_data: { intent: "appointment", proposed_slots: slots.slice(0, 3), consent_checked: true },
    recommended_actions: [{ type: "confirm_slot" }, { type: "create_appointment_after_confirmation" }],
    handover: { required: input.mode === "outbound", to_team: "在线咨询", reason: "outbound_approval" }, citations: []
  };
}

function arrivalAgent(input, context) {
  const project = detectProject(input.message, context)?.[0] || "待确认项目";
  return {
    status: "completed",
    message: "已整理本次到院交接信息：请携带有效身份信息并按预约时间到院。工作人员会先核对需求与既往沟通记录，再安排专业评估；AI不会生成面诊方案。",
    structured_data: { project, stage: context.micro_stage, handover_summary: { customer_need: context.profile.concern || "待补充", interests: context.interests, owner: context.owner, missing_fields: context.profile.budget ? [] : ["budget"] } },
    recommended_actions: [{ type: "send_arrival_instruction" }, { type: "human_verify_handover" }],
    handover: { required: false }, citations: []
  };
}

function aftercareAgent(input, context) {
  return {
    status: "approval_required",
    message: "您好，想了解一下您目前的一般感受、日常活动是否受影响，以及是否有需要工作人员协助的问题。若出现明显或持续不适，请及时联系医院，由专业人员处理；我不会在线判断异常或提供用药建议。",
    structured_data: { survey: ["当前一般感受", "是否影响日常活动", "是否需要人工回访"], abnormality_gate_enabled: true },
    recommended_actions: [{ type: "send_followup_after_approval" }, { type: "monitor_abnormal_keywords" }],
    handover: { required: true, to_team: "售后客服", reason: "followup_requires_approval" }, citations: [{ knowledge_id: "K-004", title: "项目后普通随访问卷", version: "2.2", usage: "general_followup_only" }]
  };
}

function repurchaseAgent(input, context) {
  const topInterest = detectProject(input.message, context)?.[0] || (typeof context.interests[0] === "string" ? context.interests[0] : context.interests[0]?.name) || "待确认项目";
  if (input.mode === "outbound" && !context.marketing_consent) return {
    status: "blocked", message: "客户当前没有有效营销触达授权，AI不会发送复购内容。已保留为内部机会信号，交由人工核实。",
    structured_data: { consent: "marketing_consent_missing", opportunity: topInterest }, recommended_actions: [{ type: "create_internal_opportunity", project: topInterest }], handover: { required: false }, citations: []
  };
  return {
    status: "approval_required",
    message: `系统识别到客户对“${topInterest}”的兴趣有变化，可由人工先确认长期改善计划与到院评估意愿。AI只提供机会摘要，不自动推荐医疗项目或优惠。`,
    structured_data: { opportunity: topInterest, decision: "human_confirmation_required", signals: ["interest_change", "repurchase_window"] },
    recommended_actions: [{ type: "create_human_followup", owner: context.owner }, { type: "do_not_auto_discount" }],
    handover: { required: true, to_team: "会员运营/人工咨询", reason: "medical_recommendation_prohibited" }, citations: []
  };
}

function complianceAgent(input) {
  const risk = inspectRisk(input.message);
  if (risk.decision === "handover") return handoverResult(risk, normalizeContext(input.context));
  if (risk.decision === "block") return blockedResult(risk);
  return {
    status: "completed", message: "内容检查通过，未发现需要转人工处理的医疗或合规风险，可以继续下一步。",
    structured_data: { decision: "allow", risk_matches: [], checked_rules: RISK_RULES.map((rule) => rule.id) },
    recommended_actions: [{ type: "allow_next_step" }], handover: { required: false }, citations: [{ knowledge_id: "K-005", title: "价格与效果承诺禁用表达", version: "4.1", usage: "compliance_gate" }]
  };
}

const runners = { "A-01": acquisitionAgent, "A-02": appointmentAgent, "A-03": arrivalAgent, "A-04": aftercareAgent, "A-05": repurchaseAgent, "A-06": complianceAgent };

export function routeAgent(input) {
  const text = String(input.message || "").toLowerCase();
  const stage = input.context?.macro_stage || "";
  if (["合规", "检查", "审核", "风险"].some((word) => text.includes(word)) && input.intent === "compliance_check") return "A-06";
  if (["预约", "到院时间", "几点", "周三", "周末"].some((word) => text.includes(word))) return "A-02";
  if (["到院", "签到", "地址", "停车", "面诊资料"].some((word) => text.includes(word)) || stage === "售中") return "A-03";
  if (["术后", "项目后", "恢复", "随访", "红肿", "疼痛", "异常", "用药"].some((word) => text.includes(word))) return "A-04";
  if (["复购", "再次", "会员", "长期改善"].some((word) => text.includes(word)) || (stage === "售后" && input.context?.repurchase_window)) return "A-05";
  return "A-01";
}

export function validateInvocation(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) errors.push({ field: "$", message: "请求体必须是JSON对象" });
  const message = payload?.message;
  if (typeof message !== "string" || !message.trim()) errors.push({ field: "message", message: "message为必填字符串" });
  if (typeof message === "string" && message.length > 4000) errors.push({ field: "message", message: "message不能超过4000字符" });
  if (payload?.mode && !["assist", "reply", "outbound"].includes(payload.mode)) errors.push({ field: "mode", message: "mode仅支持assist、reply、outbound" });
  if (payload?.context && (typeof payload.context !== "object" || Array.isArray(payload.context))) errors.push({ field: "context", message: "context必须是对象" });
  return errors;
}

const trustedSemanticInputs = new WeakMap();

export function invokeAgent(agentId, payload, metadata = {}) {
  const agent = AGENT_DEFINITIONS.find((item) => item.id === agentId || item.slug === agentId);
  if (!agent) return null;
  const input = { ...payload, message: payload.message.trim(), mode: payload.mode || "assist" };
  const context = normalizeContext(payload.context);
  const preRisk = inspectRisk(input.message);
  let intentAnalysis = agent.id === "A-01"
    ? recognizeAcquisitionIntent(input.message, { context, risk:preRisk, knowledgeRecords:loadHuameiKnowledge().records })
    : null;
  const semantic=trustedSemanticInputs.get(payload);
  if (semantic?.analysis && preRisk.decision==='allow' && !context.active_critical_risk) intentAnalysis=semantic.analysis;
  let result;
  if (agent.id === "A-06") result = complianceAgent({ ...input, context });
  else if (preRisk.decision === "handover") result = handoverResult(preRisk, context);
  else if (preRisk.decision === "block") result = blockedResult(preRisk);
  else if (context.active_critical_risk) result = continuingCriticalHandover(context);
  else if (semantic?.question) result={status:'completed',message:semantic.question,structured_data:{intent:'need_clarification',understanding_status:'semantic_clarification',next_questions:[semantic.question]},recommended_actions:[{type:'collect_need'}],handover:{required:false},citations:[]};
  else if (semantic?.deferOnly) result={status:'completed',message:'没关系，按您的节奏来，暂时不推进预约。',structured_data:{intent:'conversation_followup',next_questions:[]},recommended_actions:[],handover:{required:false},citations:[]};
  else if (semantic?.answers?.length) {
    const answers = semantic.answers.map(({query,analysis}) => runners[agent.id]({...input,message:query}, context, analysis));
    result = answers.find(answer=>answer.status !== 'completed') || {
      ...answers[0], message:[...new Set(answers.map(answer=>answer.message))].join('\n'),
      citations:answers.flatMap(answer=>answer.citations||[]),
      recommended_actions:answers.flatMap(answer=>answer.recommended_actions||[]),
      structured_data:{...answers[0].structured_data,projects:[...new Set(answers.flatMap(answer=>answer.structured_data?.projects||[]))]}
    };
  }
  else result = runners[agent.id](input, context, intentAnalysis);

  if (agent.id === 'A-01' && process.env.HUAMEI_NATURAL_DIALOGUE_ENABLED === 'true') {
    result = applyPresalesDialogue(result, input.message, context);
  }
  if (agent.id === "A-01") {
    result.message = normalizeAcquisitionConversationCopy(result.message, {
      intent:result.structured_data?.intent || intentAnalysis?.primary_intent,
      context
    });
  }
  const postRisk = inspectRisk(result.message, { includeHumanRequests:false });
  if (postRisk.decision === "block") result = blockedResult(postRisk);
  if (intentAnalysis) {
    // 分类器的初判用于审计；但当已审核知识把模糊词明确为某个产品、
    // 目录或医生时，后续会话必须承接“实际答复意图”，不能又退回初判的
    // need_clarification。否则会出现客户已说“面膜”仍被反复追问部位的问题。
    const responseIntent = result.structured_data?.intent || intentAnalysis.primary_intent;
    result.structured_data = {
      ...(result.structured_data || {}),
      ...(responseIntent !== intentAnalysis.primary_intent ? {
        analysis_intent:intentAnalysis.primary_intent,
        response_intent:responseIntent
      } : {}),
      intent:responseIntent,
      intent_analysis:intentAnalysis
    };
  }
  if (agent.id === "A-01") result.structured_data = {
    ...(result.structured_data || {}),
    dialogue_stage:result.structured_data?.sales_dialogue?.stage && result.structured_data.sales_dialogue.stage !== 'consultation' ? result.structured_data.sales_dialogue.stage : determineAcquisitionDialogueStage({
      intent:result.structured_data?.intent || intentAnalysis?.primary_intent,
      status:result.status,
      context,
      message:input.message
    })
  };
  if (agent.id === "A-01") {
    const answerRouting = routeAcquisitionAnswer({
      message:input.message,
      intent:result.structured_data?.intent || intentAnalysis?.primary_intent,
      analysis:intentAnalysis,
      status:result.status
    });
    const emotion = analyzeAcquisitionEmotion(input.message);
    const enriched = result.structured_data?.sales_dialogue ? {message:result.message,applied:false} : enrichAcquisitionResponseWithEmotion({
      message:result.message,
      intent:result.structured_data?.intent || intentAnalysis?.primary_intent,
      status:result.status,
      emotion
    });
    result.message = normalizeAcquisitionConversationCopy(enriched.message, {
      intent:result.structured_data?.intent || intentAnalysis?.primary_intent,
      context
    });
    result.structured_data = {
      ...(result.structured_data || {}),
      answer_routing:answerRouting,
      emotion:{
        emotion:emotion.emotion,
        intensity:emotion.intensity,
        support_applied:enriched.applied,
        engine_version:emotion.version
      }
    };
  }

  if (agent.id === "A-01") {
    const choicePrompt = deriveChoicePrompt(result.structured_data || {});
    if (choicePrompt) result.structured_data = { ...result.structured_data, choice_prompt:choicePrompt };
  }

  const now = new Date().toISOString();
  const runId = `run_${randomUUID()}`;
  const requestId = metadata.requestId || `req_${randomUUID()}`;
  const response = {
    request_id: requestId,
    run_id: runId,
    agent: { id: agent.id, slug: agent.slug, name: agent.name, version: agent.version },
    status: result.status,
    output: {
      message: result.message,
      structured_data: result.structured_data || {},
      recommended_actions: result.recommended_actions || [],
      handover: result.handover || { required: false },
      citations: result.citations || []
    },
    guardrails: {
      medical_diagnosis_allowed: false,
      suitability_judgement_allowed: false,
      consent_checked: ["A-02", "A-05"].includes(agent.id),
      compliance_gate_version: "4.2.0",
      intent_engine_version:intentAnalysis?.version || null,
      conversation_style_version:agent.id === "A-01" ? ACQUISITION_CONVERSATION_STYLE_VERSION : null,
      precheck_decision: preRisk.decision,
      postcheck_decision: postRisk.decision
    },
    usage: { provider: "local_rule_runtime", model: null, input_characters: input.message.length, output_characters: result.message.length },
    created_at: now
  };

  const audit = {
    run_id: runId, request_id: requestId, created_at: now, agent_id: agent.id, agent_version: agent.version,
    tenant_id:context.tenant_id,
    customer_id: payload.customer_id || null, channel: payload.channel || "api", mode: input.mode,
    input_preview: maskSensitive(input.message).slice(0, 160), status: result.status,
    decision: preRisk.decision, matched_rule_ids: preRisk.matches.map((item) => item.rule_id),
    caller: metadata.caller || "api_client"
  };
  runs.set(runId, { response, audit });
  if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  return response;
}

const MODEL_OUTPUT_GROUNDING_VERSION = "1.1.0";

const normalizeGroundingText = (value) => {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
};

const normalizeGroundingLexemes = (value) => {
  return normalizeGroundingText(value)
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "");
};

const groundingNgrams = (value, size = 2) => {
  const normalized = normalizeGroundingLexemes(value);
  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
};

const groundingClauses = (value) => String(value || "")
  .split(/[。！？!?；;\n]+/u)
  .map(normalizeGroundingLexemes)
  .filter((item) => item.length >= 4);

const overlapPrecision = (candidate, source) => {
  if (!candidate.size) return 1;
  let matched = 0;
  for (const item of candidate) if (source.has(item)) matched += 1;
  return matched / candidate.size;
};

/**
 * Fail-closed lexical entailment gate for customer-visible model copy.
 *
 * The model is a presentation layer, never a fact source.  A response may
 * only reproduce the already approved deterministic draft. This intentionally
 * rejects every paraphrase, deletion, reordering and connective insertion.
 * False rejection costs style; accepting one changed negation, number or
 * modality can create an unsupported medical or commercial claim.
 */
export const validateModelMessageGrounding = (modelMessage, localMessage) => {
  const model = normalizeGroundingText(modelMessage);
  const local = normalizeGroundingText(localMessage);
  const reasons = [];
  if (!model || !local) reasons.push("empty_grounding_input");
  if (model === local && model.length > 0) {
    return { passed:true, version:MODEL_OUTPUT_GROUNDING_VERSION, reason_codes:[], novel_bigram_count:0 };
  }
  reasons.push("not_exact_approved_draft");
  if (model.length > local.length + 16) reasons.push("model_copy_longer_than_approved_draft");

  const localBigrams = groundingNgrams(localMessage, 2);
  const modelBigrams = groundingNgrams(modelMessage, 2);
  const novelBigrams = [...modelBigrams].filter((item) => !localBigrams.has(item));
  const globalPrecision = overlapPrecision(modelBigrams, localBigrams);
  if (novelBigrams.length > 2 || globalPrecision < 0.95) {
    reasons.push("novel_or_unsupported_wording");
  }

  const localClauses = groundingClauses(localMessage);
  for (const clause of groundingClauses(modelMessage)) {
    const clauseGrams = groundingNgrams(clause, 2);
    const bestPrecision = Math.max(0, ...localClauses.map((sourceClause) =>
      overlapPrecision(clauseGrams, groundingNgrams(sourceClause, 2))
    ));
    if (bestPrecision < 0.9) {
      reasons.push("unsupported_clause");
      break;
    }
  }

  const localLatinTokens = new Set(String(localMessage || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  const novelLatinTokens = (String(modelMessage || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((item) => !localLatinTokens.has(item));
  if (novelLatinTokens.length) reasons.push("unsupported_identifier_or_number");

  return {
    passed:false,
    version:MODEL_OUTPUT_GROUNDING_VERSION,
    reason_codes:[...new Set(reasons)],
    novel_bigram_count:novelBigrams.length
  };
};

const GENERAL_EDUCATION_ENTERPRISE_TERMS = /(?:上海华美|华美(?:医院)?|本院|你们医院|医生|院长|主任|专家|排班|出诊|可约|预约|价格|报价|收费|活动|优惠|会员|曼托|傲诺拉|特贝茨|璀璨)/i;
const GENERAL_EDUCATION_UNSUPPORTED_DETAIL = /(?:起源|发明|最早|来自(?:于)?|法国|美国|德国|韩国|日本|中国|\d{1,4}(?:年|天|周|月|次|元|%))/;

/**
 * 对稳定的通用科普允许模型组织表达，但禁止它借此输出任何院方事实、
 * 医疗适用性或商业承诺。模型未通过时仍回退到本地审核文案。
 */
export const validateGeneralEducationMessage = (modelMessage) => {
  const message = String(modelMessage || "").trim();
  const reasons = [];
  if (message.length < 16 || message.length > 420) reasons.push("general_education_length_out_of_range");
  const sentences = message.split(/[。！？!?]+/u).map((item) => item.trim()).filter(Boolean);
  if (sentences.length < 1 || sentences.length > 4) reasons.push("general_education_sentence_count_out_of_range");
  if (GENERAL_EDUCATION_ENTERPRISE_TERMS.test(message)) reasons.push("general_education_contains_enterprise_fact");
  if (GENERAL_EDUCATION_UNSUPPORTED_DETAIL.test(message)) reasons.push("general_education_unsupported_specific_detail");
  const risk = inspectRisk(message);
  if (risk.decision !== "allow") reasons.push("general_education_medical_or_compliance_risk");
  return {
    passed:reasons.length === 0,
    version:"1.0.0",
    reason_codes:reasons,
    novel_bigram_count:null
  };
};

const mergeModelResult = (agent, input, context, localResponse, modelResult, naturalValidation = null) => {
  const localIntent = localResponse.output.structured_data?.intent;
  const intentAnalysis = localResponse.output.structured_data?.intent_analysis;
  const answerRouting = localResponse.output.structured_data?.answer_routing || {};
  const generalEducation = agent.id === "A-01" && answerRouting.model_generation_mode === "generic_education";
  const normalizedModelMessage = agent.id === "A-01"
    ? normalizeAcquisitionConversationCopy(modelResult.message, { intent:localIntent, context })
    : modelResult.message;
  const copyEvaluation = agent.id === "A-01"
    ? evaluateAcquisitionConversationCopy(normalizedModelMessage, { intent:localIntent })
    : { valid:true, reason_codes:[] };
  const grounding = naturalValidation || (generalEducation
    ? validateGeneralEducationMessage(normalizedModelMessage)
    : validateModelMessageGrounding(normalizedModelMessage, localResponse.output.message));
  // The model is a presentation-only component.  Business state, structured
  // customer data, actions, handover decisions and citations are produced by
  // deterministic policy/routing code and are never accepted from the model.
  // This prevents an otherwise perfectly copied message from smuggling fields
  // into the customer 360 profile or bypassing an approval/handover decision.
  let result = {
    status: localResponse.status,
    message: normalizedModelMessage,
    structured_data: localResponse.output.structured_data,
    recommended_actions: localResponse.output.recommended_actions,
    handover: localResponse.output.handover,
    citations: generalEducation ? [] : localResponse.output.citations
  };
  const internalLanguageRejected = containsInternalAnswerLanguage(result.message);
  const sensitiveOutputRejected = containsSensitiveOutput(result.message);
  const unexecutedActionRejected = containsUnexecutedActionClaim(result.message);
  const remoteSuitabilityProbeRejected = containsRemoteSuitabilityProbe(result.message);
  const repeatedKnownPreferenceQuestionRejected = Boolean(
    context.known_slots.style_preference
    && /(?:已有特定的改善目标|更喜欢哪种(?:风格|效果)|想要什么(?:风格|效果))/.test(result.message)
  );
  const repeatedKnownConcernQuestionRejected = Boolean(
    intentAnalysis?.entities?.concerns?.length
    && intentAnalysis?.entities?.body_parts?.length
    && /(?:哪个|哪一)(?:个)?部位|关注哪个部位|改善什么问题/.test(result.message)
  );
  const copyStyleRejected = !copyEvaluation.valid;
  const namedDoctor = localIntent === "doctor_profile"
    ? extractNamedDoctorName(input.message)
    : "";
  const doctorIntentDrift = Boolean(namedDoctor && !result.message.includes(namedDoctor));
  const doctorCandidates = localIntent === "doctor_discovery_by_project"
    ? (localResponse.output.structured_data?.doctor_candidates || []).map((item) => item.name).filter(Boolean)
    : [];
  const doctorRecommendationDrift = doctorCandidates.length > 0 && !doctorCandidates.some((name) => result.message.includes(name));
  if (!grounding.passed || internalLanguageRejected || sensitiveOutputRejected || unexecutedActionRejected || remoteSuitabilityProbeRejected || repeatedKnownPreferenceQuestionRejected || repeatedKnownConcernQuestionRejected || copyStyleRejected || doctorIntentDrift || doctorRecommendationDrift) {
    result = {
      status: localResponse.status,
      message: localResponse.output.message,
      structured_data: localResponse.output.structured_data,
      recommended_actions: localResponse.output.recommended_actions,
      handover: localResponse.output.handover,
      citations: localResponse.output.citations
    };
  }
  const postRisk = inspectRisk(result.message, { includeHumanRequests:false });
  if (postRisk.decision === "block") result = blockedResult(postRisk);
  else if (postRisk.decision === "handover" && agent.id !== "A-06") {
    // 用户输入已通过确定性前置门禁时，模型若在安全提示中误触发“适合做/建议做”等词，
    // 回退到本地已审核知识答案，而不是把正常项目咨询错误升级为人工转接。
    result = {
      status: localResponse.status,
      message: localResponse.output.message,
      structured_data: localResponse.output.structured_data,
      recommended_actions: localResponse.output.recommended_actions,
      handover: localResponse.output.handover,
      citations: localResponse.output.citations
    };
  }
  return {
    result,
    postRisk,
    copyStyleIssues:copyEvaluation.reason_codes,
    grounding,
    modelOutputRejected:!grounding.passed || internalLanguageRejected || sensitiveOutputRejected || unexecutedActionRejected || remoteSuitabilityProbeRejected || repeatedKnownPreferenceQuestionRejected || repeatedKnownConcernQuestionRejected || copyStyleRejected || doctorIntentDrift || doctorRecommendationDrift || postRisk.decision !== "allow"
  };
};

export async function invokeAgentAsync(agentId, payload, metadata = {}) {
  const latencyStartedAt = performance.now();
  const latencyBreakdown = {
    planning_ms:0,
    deterministic_planning_ms:0,
    graphrag_request_ms:0,
    graphrag_service_ms:null,
    graphrag_queue_ms:null,
    graphrag_search_ms:null,
    graphrag_query_model_calls:0,
    evidence_filter_ms:0,
    generation_ms:0,
    review_ms:0,
    total_ms:null
  };
  const elapsedMs = (startedAt) => Number((performance.now() - startedAt).toFixed(2));
  const definition=AGENT_DEFINITIONS.find(item=>item.id===agentId||item.slug===agentId);
  const originalContext=normalizeContext(payload.context);
  const semanticRisk=inspectRisk(payload.message);
  let plan={used:false,reason:'safety_or_other_agent'};
  if(definition?.id==='A-01' && semanticRisk.decision==='allow' && !originalContext.active_critical_risk) {
    plan=shouldUseFastPlanning({message:payload.message,context:originalContext,risk:semanticRisk})
      ? {used:false,reason:'deterministic_fast_path',latency_ms:0}
      : await planDialogueTurnWithLlm({input:payload,context:originalContext});
  }
  latencyBreakdown.planning_ms = Number(plan.latency_ms) || 0;
  const trusted={};
  if(plan.used) {
    const context=applyTurnPlanContext(originalContext,plan);
    const knowledgeRecords=loadHuameiKnowledge().records;
    const sourceAnalysis=recognizeAcquisitionIntent(payload.message+' '+originalContext.recent_turns.map(t=>t.content).join(' '),{context:originalContext,risk:semanticRisk,knowledgeRecords});
    const sourceEntities=new Set([...(sourceAnalysis.entities?.projects||[]),...(sourceAnalysis.entities?.doctors||[]),...originalContext.known_projects,...originalContext.known_doctors]);
    const answers=plan.questions.map(q=>{
      const analysis=recognizeAcquisitionIntent(q.query,{context,risk:semanticRisk,knowledgeRecords});
      const linked=[...(analysis.entities?.projects||[]),...(analysis.entities?.doctors||[])];
      if(inspectRisk(q.query).decision!=='allow' || linked.some(name=>!sourceEntities.has(name)))return null;
      return {query:q.query,analysis:{...analysis,primary_intent:q.intent,domain:INTENT_ONTOLOGY[q.intent]?.domain||'conversation',confidence:plan.confidence,clarification_required:false,semantic_refined:true}};
    });
    if(answers.some(answer=>!answer))plan={used:false,reason:'untrusted_query_or_entity'};
    else if(plan.next_step==='clarify' && !canUseSemanticQuestion({used:true,confidence:plan.confidence,needs_clarification:true,question:plan.clarification},inspectRisk))plan={used:false,reason:'unsafe_clarification'};
    else {
      payload={...payload,context};
      trusted.answers=answers;
      trusted.deferOnly=plan.next_step==='defer' && !answers.length;
      trusted.analysis=answers[0]?.analysis || {...recognizeAcquisitionIntent(payload.message,{context,risk:semanticRisk,knowledgeRecords}),primary_intent:plan.intent,domain:INTENT_ONTOLOGY[plan.intent]?.domain||'conversation',confidence:plan.confidence,clarification_required:plan.next_step==='clarify',semantic_refined:true};
      if(plan.next_step==='clarify')trusted.question=plan.clarification;
      trustedSemanticInputs.set(payload,trusted);
    }
  }
  // Only an in-process domain callback may perform a write. User JSON is never
  // interpreted as an executable tool call, and safety/handover wins first.
  const contact=definition?.id==='A-01' && semanticRisk.decision==='allow' && !originalContext.active_critical_risk && typeof metadata.captureContact==='function'
    ? await metadata.captureContact(plan) : null;
  const deterministicStartedAt = performance.now();
  const localResponse = invokeAgent(agentId, payload, metadata);
  latencyBreakdown.deterministic_planning_ms = elapsedMs(deterministicStartedAt);
  const finalize=response=>{
    if(contact) {
      response.lead_receipt=contact.receipt;
      if(response.status==='completed' && !response.output.handover?.required) {
        response.output.message=contact.remaining_message ? contact.receipt.message+'\n'+response.output.message : contact.receipt.message;
        if(!contact.remaining_message)response.output.structured_data.intent='contact_submission';
      }
      response.output.structured_data.contact_capture_status=contact.receipt.status;
    }
    response.guardrails.turn_planning={used:plan.used,reason:plan.reason||'completed',version:plan.version||null,latency_ms:plan.latency_ms||0,discarded_task:plan.discarded_task||false,discarded_slot_updates:plan.discarded_slot_updates||0,discarded_next_step:plan.discarded_next_step||false};
    response.guardrails.semantic_understanding={used:plan.used,applied:plan.used,reason:plan.reason||'unified_turn_plan'};
    latencyBreakdown.total_ms = elapsedMs(latencyStartedAt);
    response.guardrails.latency_breakdown = { ...latencyBreakdown };
    if(plan.used) {
      response.output.structured_data.turn_plan=plan;
      response.usage={...response.usage,planning_total_tokens:plan.usage?.total_tokens||0,total_tokens:(response.usage?.total_tokens||0)+(plan.usage?.total_tokens||0)};
    }
    return persistFinalRun(response);
  };
  if (!localResponse) return null;
  const agent = AGENT_DEFINITIONS.find((item) => item.id === localResponse.agent.id);
  const input = { ...payload, message: payload.message.trim(), mode: payload.mode || "assist" };
  const context = {...normalizeContext(payload.context),...(plan.used ? {turn_plan:plan} : {})};
  if(plan.used)localResponse.output.structured_data.turn_plan=plan;
  if(contact && !contact.remaining_message) {
    localResponse.output=contact.result.output;
    localResponse.status=contact.result.status;
    localResponse.guardrails.llm_used=false;
    return finalize(localResponse);
  }
  const localIntent = localResponse.output.structured_data?.intent || "";
  const answerRouting = localResponse.output.structured_data?.answer_routing || {};
  context.dialogue_stage = localResponse.output.structured_data?.dialogue_stage || context.dialogue_stage;
  if (agent.id === 'A-01' && process.env.HUAMEI_NATURAL_DIALOGUE_ENABLED === 'true' && localResponse.status === 'completed') {
    localResponse.output.message = localResponse.output.message.replace(/还有其他想了解的吗？\s*或者帮您预约专家做进一步分析？\s*$/, '').trim();
    if (localResponse.output.structured_data?.next_questions) localResponse.output.structured_data.next_questions = localResponse.output.structured_data.next_questions.filter(q=>!q.includes('还有其他想了解的吗'));
    if (!localResponse.output.structured_data?.sales_dialogue && /担心|顾虑|犹豫/.test(input.message) && /不约|先不|暂时不/.test(input.message)) {
      localResponse.output.message = '不用急着预约。您目前最担心的是哪一方面？';
      localResponse.output.structured_data.next_questions = ['您目前最担心的是哪一方面？'];
    }
  }

  if (["blocked", "handover_required"].includes(localResponse.status)) {
    localResponse.guardrails.llm_used = false;
    localResponse.guardrails.llm_skip_reason = "deterministic_guardrail";
    return finalize(localResponse);
  }

  if(agent.id==='A-01' && localResponse.output.structured_data?.understanding_status==='semantic_clarification') {
    localResponse.guardrails.llm_used=true;
    localResponse.guardrails.client_output_source='validated_semantic_clarification';
    return finalize(localResponse);
  }
  if (agent.id === "A-01" && process.env.HUAMEI_NATURAL_DIALOGUE_ENABLED !== "true" && ["conversation_acknowledgement", "conversation_greeting"].includes(localIntent)) {
    localResponse.guardrails.llm_used = false;
    localResponse.guardrails.llm_skip_reason = localIntent === "conversation_greeting"
      ? "deterministic_greeting"
      : "deterministic_acknowledgement";
    localResponse.guardrails.graphrag_used = false;
    localResponse.guardrails.graphrag_fallback_reason = "retrieval_not_needed";
    return finalize(localResponse);
  }

  if (agent.id === "A-01" && answerRouting.retrieval_strategy === "graph_rag") {
    const admission = getHuameiKnowledgeStatus(context.tenant_id).admission;
    if (admission.ready) {
      const formalLoadEntry = metadata.formalLoadTaxonomyEntry;
      if (formalLoadEntry && !isValidatedFormalLoadTaxonomyEntry(formalLoadEntry)) {
        const error = new Error("正式压测taxonomy entry未通过服务端验证");
        error.code = "FORMAL_LOAD_TAXONOMY_ENTRY_UNTRUSTED";
        throw error;
      }
      if (formalLoadEntry && (
        formalLoadEntry.tenantId !== context.tenant_id
        || formalLoadEntry.knowledgeReleaseId !== admission.active_release?.id
        || formalLoadEntry.indexVersion !== admission.active_release?.manifest?.index_version
      )) {
        const error = new Error("正式压测taxonomy entry与当前激活知识版本不一致");
        error.code = "FORMAL_LOAD_TAXONOMY_ACTIVE_RELEASE_MISMATCH";
        throw error;
      }
      const graphQuery = formalLoadEntry?.query || buildGraphRagQuery(input.message, localResponse, context);
      if (formalLoadEntry) {
        localResponse.guardrails.formal_load_taxonomy = {
          entry_id:formalLoadEntry.entryId,
          manifest_id:formalLoadEntry.manifestId,
          manifest_sha256:formalLoadEntry.manifestSha256,
          signer_id:formalLoadEntry.signerId,
          signed_payload_sha256:formalLoadEntry.signedPayloadSha256,
          catalog_sha256:formalLoadEntry.catalogSha256,
          algorithm_version:formalLoadEntry.algorithmVersion
        };
      }
      if (!graphQuery) {
        localResponse.guardrails.graphrag_used = false;
        localResponse.guardrails.graphrag_fallback_reason = "no_safe_retrieval_terms";
      } else {
        const graphParams = graphRagParamsForIntent(localIntent);
        localResponse.guardrails.graphrag_params = graphParams;
        const evidenceOnly = graphRagEvidenceOnlyEnabled();
        localResponse.guardrails.graphrag_evidence_only = evidenceOnly;
        const graphStartedAt = performance.now();
        const graphResult = await retrieveGraphRagKnowledge(graphQuery, {
          tenantId:context.tenant_id,
          releaseId:admission.active_release?.id || null,
          indexVersion:admission.active_release?.manifest?.index_version || null,
          requestId:metadata.requestId,
          evidenceOnly,
          topK:graphParams.topK,
          ...(graphParams.topKEntities ? { topKEntities:graphParams.topKEntities } : {}),
          ...(graphParams.topKRelationships ? { topKRelationships:graphParams.topKRelationships } : {}),
          ...(graphParams.maxContextTokens ? { maxContextTokens:graphParams.maxContextTokens } : {})
        });
        latencyBreakdown.graphrag_request_ms = elapsedMs(graphStartedAt);
        latencyBreakdown.graphrag_service_ms = graphResult.timingMs ?? null;
        latencyBreakdown.graphrag_queue_ms = graphResult.queueMs ?? null;
        latencyBreakdown.graphrag_search_ms = graphResult.searchMs ?? null;
        latencyBreakdown.graphrag_query_model_calls = Number(graphResult.queryModelAttempts) || 0;
        localResponse.guardrails.graphrag_timing_ms = graphResult.timingMs ?? null;
        localResponse.guardrails.graphrag_search_ms = graphResult.searchMs ?? null;
        localResponse.guardrails.graphrag_queue_ms = graphResult.queueMs ?? null;
        localResponse.guardrails.graphrag_context_tokens = graphResult.contextTokens ?? null;
        localResponse.guardrails.graphrag_query_model_calls = Number(graphResult.queryModelAttempts) || 0;
        localResponse.guardrails.graphrag_query_model_accounting = graphResult.queryModelAccounting || null;
        localResponse.guardrails.graphrag_cache_hit = graphResult.cacheHit === true;
        localResponse.guardrails.graphrag_query_sha256 = graphResult.querySha256 || null;
        if (formalLoadEntry && graphResult.querySha256 !== formalLoadEntry.querySha256) {
          const error = new Error("正式压测taxonomy query摘要与批准entry不一致");
          error.code = "FORMAL_LOAD_TAXONOMY_QUERY_HASH_MISMATCH";
          throw error;
        }
        const evidenceFilterStartedAt = performance.now();
        if (graphResult.used) {
          attachGraphRagEvidence(localResponse, graphResult, context, input.message);
        } else {
          localResponse.guardrails.graphrag_used = false;
          localResponse.guardrails.graphrag_fallback_reason = graphResult.reason;
        }
        latencyBreakdown.evidence_filter_ms = elapsedMs(evidenceFilterStartedAt);
      }
    } else {
      localResponse.guardrails.graphrag_used = false;
      localResponse.guardrails.graphrag_fallback_reason = "knowledge_release_not_ready";
    }
  } else if (agent.id === "A-01") {
    localResponse.guardrails.graphrag_used = false;
    localResponse.guardrails.graphrag_fallback_reason = answerRouting.route === "enterprise_knowledge_graph"
      ? `not_selected_${answerRouting.retrieval_strategy || "unknown"}`
      : "answer_routing_no_enterprise_evidence";
  }

  if (agent.id === "A-01" && localIntent === "doctor_project_verification") {
    if (localResponse.guardrails.graphrag_used) {
      const evidence = localResponse.output.structured_data?.knowledge_hits || [];
      const titles = [...new Set(evidence.map((item) => item.title).filter(Boolean))].slice(0, 3);
      localResponse.output.message = `已按已发布医生资料核验到${titles.length ? titles.join("、") : "相关公开方向"}。具体擅长范围和近期排班仍以院方最新信息为准。`;
      localResponse.output.structured_data.next_questions = ["您想继续了解这位医生的项目方向，还是请人工顾问核验最新排班？"];
    } else {
      localResponse.status = "handover_required";
      localResponse.output.message = "目前未取得足以确认这位医生完整项目范围的已发布关系依据，不能凭目录或姓名推断擅长项目。已转人工顾问核实。";
      localResponse.output.handover = { required:true, to_team:"在线咨询", reason:"doctor_project_relation_unverified" };
      localResponse.output.citations = [];
      localResponse.guardrails.llm_used = false;
      localResponse.guardrails.llm_skip_reason = "doctor_project_relation_unverified";
    }
    return finalize(localResponse);
  }

  // 对“某一明确产品究竟是什么形状/表面”的事实核验，答案应逐字受已准入
  // 证据约束。此类响应仍经过GraphRAG绑定和引用筛选，但不再交给生成模型
  // 扩写，以免追加“更自然、触感更好”等来源没有支持的卖点。
  if (agent.id === "A-01" && localIntent === "product_attribute_verification") {
    localResponse.guardrails.llm_used = false;
    localResponse.guardrails.llm_skip_reason = "deterministic_fact_verification";
    return finalize(localResponse);
  }

  try {
    const completion = await completeAgentWithLlm({ agent, input, context, localResult: localResponse.output });
    if (!completion.used) {
      localResponse.guardrails.llm_used = false;
      localResponse.guardrails.llm_skip_reason = completion.reason;
      return finalize(localResponse);
    }
    latencyBreakdown.generation_ms = Number(completion.usage?.generation_latency_ms) || 0;
    latencyBreakdown.review_ms = Number(completion.usage?.review_latency_ms) || 0;
    const { result, postRisk, copyStyleIssues, grounding, modelOutputRejected } = mergeModelResult(agent, input, context, localResponse, completion.result, completion.naturalValidation);
    localResponse.status = result.status;
    localResponse.output = {
      message: result.message,
      structured_data: result.structured_data || {},
      recommended_actions: result.recommended_actions || [],
      handover: result.handover || { required: false },
      citations: result.citations || []
    };
    localResponse.guardrails.llm_used = true;
    localResponse.guardrails.model_output_validated = !modelOutputRejected;
    localResponse.guardrails.model_output_rejected = modelOutputRejected;
    localResponse.guardrails.model_output_grounding = grounding;
    localResponse.guardrails.client_output_source = modelOutputRejected
      ? "deterministic_fallback"
      : completion.naturalValidation ? "validated_natural_dialogue" : answerRouting.model_generation_mode === "generic_education" ? "model_general_education" : "grounded_model_copy";
    localResponse.guardrails.copy_style_issues = copyStyleIssues;
    localResponse.guardrails.postcheck_decision = postRisk.decision;
    localResponse.usage = {
      ...completion.usage,
      input_characters: input.message.length,
      output_characters: result.message.length
    };
  } catch (error) {
    const status = getLlmStatus();
    localResponse.guardrails.llm_used = false;
    localResponse.guardrails.llm_fallback = true;
    localResponse.guardrails.llm_fallback_reason = error?.code || "MODEL_RUNTIME_ERROR";
    localResponse.usage = {
      provider: "local_rule_runtime_fallback",
      model: status.model,
      input_characters: input.message.length,
      output_characters: localResponse.output.message.length
    };
  }

  const run = runs.get(localResponse.run_id);
  if (run) {
    run.response = localResponse;
    run.audit.status = localResponse.status;
    run.audit.provider = localResponse.usage.provider;
    run.audit.model = localResponse.usage.model;
    run.audit.llm_used = localResponse.guardrails.llm_used === true;
  }
  return finalize(localResponse);
}

export function invokeRouter(payload, metadata = {}) {
  const agentId = routeAgent(payload);
  const response = invokeAgent(agentId, payload, metadata);
  return { ...response, routing: { selected_agent_id: agentId, reason: "lifecycle_intent_and_risk_rules", router_version: "1.0.0" } };
}

export async function invokeRouterAsync(payload, metadata = {}) {
  const agentId = routeAgent(payload);
  const response = await invokeAgentAsync(agentId, payload, metadata);
  return { ...response, routing: { selected_agent_id: agentId, reason: "lifecycle_intent_and_risk_rules", router_version: "1.1.0" } };
}

export const getRun = (runId) => runs.get(runId) || null;
export const listRuns = (limit = 50) => [...runs.values()].slice(-Math.min(Math.max(Number(limit) || 50, 1), 100)).reverse().map((item) => item.audit);
export const getRunAsync = async (runId, tenantId) => {
  const normalizedTenantId = tenantId ? normalizeTenantId(tenantId) : undefined;
  const memoryRun = runs.get(runId);
  if (memoryRun && (!normalizedTenantId || memoryRun.audit?.tenant_id === normalizedTenantId)) return memoryRun;
  return postgresPersistenceEnabled() ? getPostgresAgentRunStore().get(runId, normalizedTenantId) : null;
};
export const listRunsAsync = async (limit = 50, tenantId, agentId = "") => postgresPersistenceEnabled()
  ? getPostgresAgentRunStore().list({ tenantId:tenantId ? normalizeTenantId(tenantId) : undefined, agentId, limit })
  : listRuns(limit).filter((item) => (!tenantId || item.tenant_id === normalizeTenantId(tenantId)) && (!agentId || item.agent_id === agentId));
export const resetRunsForTest = () => runs.clear();
