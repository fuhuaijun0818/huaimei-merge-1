import { projectKnowledge } from "../src/project-knowledge.js";
import { understandConcern } from "./acquisition-concern-understanding.mjs";
import { resolvePendingChoice, resolveBreastMethodCorrection } from "./acquisition-choice-slots.mjs";

export const INTENT_ENGINE_VERSION = "3.3.0";

export const INTENT_ONTOLOGY = Object.freeze({
  medical_emergency:{ domain:"risk", evidence_route:"none", action:"handover_medical_urgent" },
  medical_safety:{ domain:"risk", evidence_route:"none", action:"handover_medical" },
  medical_suitability:{ domain:"risk", evidence_route:"none", action:"handover_doctor" },
  privacy_or_complaint:{ domain:"risk", evidence_route:"none", action:"handover_responsible_team" },
  human_handover_request:{ domain:"conversion", evidence_route:"none", action:"handover_human_consultant" },
  security_or_compliance:{ domain:"risk", evidence_route:"none", action:"block" },
  project_explanation:{ domain:"project", evidence_route:"approved_project_knowledge", action:"explain_project" },
  project_comparison:{ domain:"project", evidence_route:"approved_project_knowledge", action:"compare_projects" },
  project_discovery_by_concern:{ domain:"project", evidence_route:"approved_project_knowledge", action:"present_project_directions" },
  product_attribute_verification:{ domain:"project", evidence_route:"price_and_policy", action:"verify_product_attribute" },
  doctor_profile:{ domain:"doctor", evidence_route:"doctor_profiles", action:"explain_named_doctor" },
  doctor_discovery_by_project:{ domain:"doctor", evidence_route:"doctor_profiles", action:"present_doctor_candidates" },
  doctor_comparison:{ domain:"doctor", evidence_route:"doctor_profiles", action:"compare_doctor_profiles" },
  doctor_schedule_verification:{ domain:"doctor", evidence_route:"doctor_profiles", action:"verify_doctor_schedule" },
  price_verification:{ domain:"commercial", evidence_route:"price_and_policy", action:"verify_current_price" },
  policy_verification:{ domain:"commercial", evidence_route:"price_and_policy", action:"verify_current_policy" },
  directory_discovery:{ domain:"navigation", evidence_route:"directory_overview", action:"navigate_knowledge_scope" },
  appointment_query:{ domain:"conversion", evidence_route:"appointment_service", action:"clarify_appointment" },
  appointment_request:{ domain:"conversion", evidence_route:"appointment_service", action:"request_human_appointment" },
  consultation_process:{ domain:"service", evidence_route:"none", action:"explain_general_consultation_process" },
  service_information:{ domain:"service", evidence_route:"service_information", action:"provide_or_verify_service_info" },
  case_request_restricted:{ domain:"restricted", evidence_route:"restricted_metadata_only", action:"refuse_restricted_case_content" },
  conversation_greeting:{ domain:"conversation", evidence_route:"none", action:"introduce_hospital_and_discover_need" },
  conversation_acknowledgement:{ domain:"conversation", evidence_route:"none", action:"acknowledge_without_reopening_discovery" },
  conversation_followup:{ domain:"conversation", evidence_route:"contextual", action:"continue_from_confirmed_context" },
  need_clarification:{ domain:"conversation", evidence_route:"none", action:"ask_one_clarifying_question" }
});

const PROJECT_ALIAS_OVERRIDES = [
  { canonical:"胸部整形", aliases:["胸部整形", "隆胸", "丰胸", "美胸", "乳房整形"] },
  { canonical:"鼻部整形", aliases:["鼻部整形", "鼻整形", "隆鼻", "鼻综合", "鼻修复"] },
  { canonical:"眼部整形", aliases:["眼部整形", "双眼皮", "重睑", "眼综合", "祛眼袋", "去眼袋", "提眉"] },
  { canonical:"面部年轻化", aliases:["面部年轻化", "面部提升", "抗衰", "抗初老", "拉皮", "微拉美", "线雕"] },
  { canonical:"自体脂肪", aliases:["自体脂肪", "脂肪填充", "脂肪移植", "脂肪隆胸"] },
  { canonical:"皮肤美容", aliases:["皮肤美容", "光子嫩肤", "皮秒", "水光", "祛斑", "美白", "嫩肤"] },
  { canonical:"形体塑形", aliases:["形体塑形", "吸脂", "减脂", "瘦腰", "瘦腿", "瘦手臂"] },
  { canonical:"面部轮廓", aliases:["面部轮廓", "轮廓整形", "下颌角", "颧骨", "改脸型", "下巴整形"] },
  { canonical:"口腔美容", aliases:["口腔美容", "牙齿矫正", "正畸", "洁牙", "牙齿美白"] },
  { canonical:"毛发移植", aliases:["毛发移植", "植发", "发际线"] }
];

export const DOCTOR_PROJECT_GROUPS = Object.freeze([
  { id:"breast", label:"胸部整形", triggers:["胸部整形", "隆胸", "丰胸", "美胸", "胸部", "乳房"], evidenceTerms:["胸部整形", "隆胸", "丰胸", "美胸"] },
  { id:"nose", label:"鼻部整形", triggers:["鼻部整形", "鼻整形", "隆鼻", "鼻综合", "鼻修复", "鼻子"], evidenceTerms:["鼻部整形", "鼻整形", "隆鼻", "鼻综合", "鼻修复"] },
  { id:"eye", label:"眼部整形", triggers:["眼部整形", "双眼皮", "眼袋", "提眉", "眼综合"], evidenceTerms:["眼部整形", "双眼皮", "眼袋", "提眉", "眼综合"] },
  { id:"rejuvenation", label:"面部年轻化与提升", triggers:["面部年轻化", "面部提升", "拉皮", "微拉美", "抗衰", "抗初老", "松弛"], evidenceTerms:["面部年轻化", "面部提升", "拉皮", "微拉美", "抗衰", "深层复位提升"] },
  { id:"fat", label:"脂肪与形体塑形", triggers:["自体脂肪", "脂肪填充", "脂肪移植", "吸脂", "形体塑形"], evidenceTerms:["自体脂肪", "脂肪填充", "脂肪移植", "吸脂", "形体塑形"] },
  { id:"contour", label:"面部轮廓", triggers:["面部轮廓", "下颌角", "颧骨", "改脸型"], evidenceTerms:["面部轮廓", "下颌角", "颧骨", "改脸型"] }
]);

const CONCERN_TERMS = [
  "松弛", "下垂", "皱纹", "法令纹", "暗沉", "发黄", "色斑", "斑点", "痘印", "痘坑", "毛孔", "缺水", "干燥",
  "胎记", "太田痣", "鲜红斑痣", "雀斑样痣", "咖啡斑", "色素痣", "黑痣", "痣", "血管瘤",
  "眼袋", "泪沟", "内双", "鼻梁", "鼻尖", "鼻翼", "咬肌", "下颌线", "双下巴", "胸部不对称", "腰腹", "大腿", "手臂"
];

const INTENT_PROTOTYPES = {
  project_explanation:["介绍一下热玛吉", "这个项目是什么", "想了解双眼皮项目"],
  project_comparison:["热玛吉和线雕有什么区别", "两个项目怎么选", "对比一下隆鼻方式"],
  project_discovery_by_concern:["脸松弛有什么项目", "皮肤暗沉怎么改善", "我想改善眼袋"],
  product_attribute_verification:["璀璨是水滴形吗", "这个假体是圆形还是解剖型", "星熠是光面吗"],
  doctor_profile:["李健院长", "介绍一下叶丽萍医生", "医生擅长什么"],
  doctor_discovery_by_project:["胸部整形推荐哪个医生", "隆鼻找哪位院长", "双眼皮谁做"],
  doctor_comparison:["李健和叶丽萍怎么选", "两位医生有什么区别", "对比医生专业方向"],
  doctor_schedule_verification:["李健今天出诊吗", "医生什么时候在院", "院长可以预约吗"],
  price_verification:["双眼皮多少钱", "预算一万够吗", "项目怎么收费"],
  policy_verification:["活动现在有效吗", "套餐包含什么", "六月政策还能用吗"],
  directory_discovery:["有哪些项目资料", "这个目录下面有什么", "医院服务范围"],
  appointment_query:["什么时候可以到院", "周末能预约吗", "有哪些可约时间"],
  appointment_request:["帮我预约", "我要约面诊", "安排到院"],
  service_information:["医院地址在哪", "怎么停车", "营业时间"],
  case_request_restricted:["看看术前术后案例", "发医生案例给我", "有对比照片吗"],
  conversation_greeting:["你好", "您好", "哈喽", "hi"],
  conversation_acknowledgement:["好的", "嗯嗯", "知道了", "谢谢", "先这样"],
  conversation_followup:["那下一步呢", "刚才那个呢", "继续说"],
  need_clarification:["我想了解一下", "有什么推荐", "先看看"]
};

const normalize = (value = "") => String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const unique = (values) => [...new Set(values.filter(Boolean))];
const clamp = (value, min = 0, max = 1) => Math.min(Math.max(value, min), max);

const GENERIC_DOCTOR_NAME_PARTS = /(?:推荐|哪个|哪位|什么|哪一|谁|了解|介绍|咨询|请问|想问|想找|适合|最好|一位|有无|有没有)/;
const NON_NAME_DOCTOR_PREFIX = /(?:的$|双眼皮|眼整形|鼻整形|隆鼻|胸整形|隆胸|抗衰|拉皮|线雕|吸脂|脂肪|项目|做)/;
const DOCTOR_RECOMMENDATION_INTENT = /(?:(?:推荐|选择|找|看|约)(?:.{0,12})?(?:院长|医生|主任|专家)|(?:哪位|哪个|什么|谁)(?:院长|医生|主任|专家)|(?:院长|医生|主任|专家)(?:怎么选|如何选|推荐|有哪些|有谁|都有谁|哪几位))/i;
// 用户往往只会回复上一轮给出的选项，例如“自体脂肪方式”。这不是一个新的
// 泛“脂肪填充”话题，而是对“假体 / 自体脂肪丰胸”二选一问题的明确选择。
// 同时覆盖常见的省略表达，避免必须机械复述“自体脂肪隆胸”才能被识别。
const BREAST_TYPE_SELECTION = /^\s*(?:假体(?:方式|丰胸|隆胸)?|丰胸假体|自体脂肪(?:方式|丰胸|隆胸)?|脂肪(?:方式|丰胸|隆胸)?)\s*[。！？!?]?\s*$/;

const isBreastTypeSelection = (message = "") => BREAST_TYPE_SELECTION.test(String(message));

// 会话持久化保存的是待选项的 value（例如 autologous_fat），而回答层使用
// fat / implant 作为分支值。必须在意图层统一归一，否则客户选完方式后再问
// “这是什么原理”会失去项目锚点，错误落入泛项目推荐。
const normalizeBreastMethod = (value = "") => {
  const normalized = normalize(value);
  if (["implant", "假体", "假体丰胸", "假体隆胸"].includes(normalized)) return "implant";
  if (["fat", "autologousfat", "autologous_fat", "自体脂肪", "自体脂肪丰胸", "自体脂肪隆胸", "脂肪丰胸", "脂肪隆胸"].includes(normalized)) return "fat";
  return "";
};

const breastProjectForMethod = (method = "") => method === "implant"
  ? "假体隆胸"
  : method === "fat"
    ? "自体脂肪隆胸"
    : "";

const CONTEXTUAL_BREAST_FACET = /(?:原理|是什么|怎么做|流程|步骤|恢复期?|术后|消肿|拆线|住院|休息几天|请假几天|多久(?:恢复|消肿|能上班|能工作|能运动)|注意|形态|圆形|水滴形|水滴型|解剖型)/;

const hasBreastSelectionContext = (context = {}) => {
  const projects = [
    ...(Array.isArray(context.interests) ? context.interests : []),
    ...(Array.isArray(context.known_projects) ? context.known_projects : [])
  ].map((item) => typeof item === "string" ? item : item?.name).filter(Boolean).join(" ");
  const recentAssistantText = (Array.isArray(context.recent_turns) ? context.recent_turns : [])
    .filter((turn) => turn?.role === "assistant")
    .map((turn) => String(turn?.content || ""))
    .join(" ");
  return /(?:胸部|丰胸|隆胸|乳房)/.test(projects)
    || /(?:假体(?:丰胸|隆胸)?.{0,20}(?:还是|或).{0,20}自体脂肪|自体脂肪(?:丰胸|隆胸)?.{0,20}(?:还是|或).{0,20}假体)/.test(recentAssistantText);
};

export const extractNamedDoctorName = (message = "") => {
  const match = String(message).match(/([\p{Script=Han}]{2,4})(?:院长|医生|主任|专家)/u);
  if (!match) return "";
  let candidate = match[1];
  // 匹配窗口最多取称谓前四个汉字，例如“想了解一下李健院长”会先得到“\n+  // 一下李健”。把口语填充词一并剥离，避免把“一下”当作医生姓名的一部分。
  for (const prefix of ["了解一下", "介绍一下", "咨询一下", "请问一下", "一下", "了解", "介绍", "咨询", "请问", "想问", "想找", "关于", "认识"]) {
    if (candidate.startsWith(prefix) && candidate.length - prefix.length >= 2) candidate = candidate.slice(prefix.length);
  }
  return GENERIC_DOCTOR_NAME_PARTS.test(candidate) || NON_NAME_DOCTOR_PREFIX.test(candidate) ? "" : candidate;
};

export const isDoctorRecommendationIntent = (message = "") =>
  !extractNamedDoctorName(message) && DOCTOR_RECOMMENDATION_INTENT.test(String(message));

export const doctorProjectGroupFor = (message = "") => {
  const query = normalize(message);
  return DOCTOR_PROJECT_GROUPS.find((group) => group.triggers.some((term) => query.includes(normalize(term)))) || null;
};

let catalogCache = { records:null, catalog:null };

export function buildAcquisitionEntityCatalog(knowledgeRecords = []) {
  if (catalogCache.records === knowledgeRecords && catalogCache.catalog) return catalogCache.catalog;
  const projectAliases = new Map();
  for (const item of projectKnowledge) {
    const canonical = String(item.project || item.cardTitle || "").trim();
    for (const alias of [item.project, item.cardTitle, item.sourceTitle, item.brandOrModel]) {
      const normalized = normalize(alias);
      if (canonical && normalized.length >= 2) projectAliases.set(normalized, { canonical, alias:String(alias), source:"project_knowledge" });
    }
  }
  for (const group of PROJECT_ALIAS_OVERRIDES) {
    for (const alias of group.aliases) projectAliases.set(normalize(alias), { canonical:group.canonical, alias, source:"business_alias" });
  }
  const doctors = new Set();
  const departments = new Set();
  const addDoctor = (name) => {
    const full = String(name || "").trim();
    if (!full) return;
    doctors.add(full);
    // Doctor records commonly include an honorific ("张群院长") or a title
    // ("李帅华 技术院长"). Add the bare name so customer mentions such as
    // "张群" or "李帅华" resolve to the same verified directory entry.
    const bare = full.replace(/\s*(?:技术院长|院长|主任|医生|专家)$/u, "").trim();
    if (bare.length >= 2 && bare !== full && !/^(?:大光电|美肤中心)$/u.test(bare)) doctors.add(bare);
  };
  for (const record of knowledgeRecords) {
    const parts = String(record.source_relative_path || "").split("/");
    if (parts[0] === "医生介绍" && parts.length >= 3 && parts[2] && !/\.[a-z0-9]+$/i.test(parts[2])) addDoctor(parts[2]);
    if (["医生介绍", "项目介绍", "项目价格"].includes(parts[0]) && parts[1] && !/\.[a-z0-9]+$/i.test(parts[1])) departments.add(parts[1]);
  }
  const catalog = {
    version:INTENT_ENGINE_VERSION,
    projects:[...projectAliases.values()].sort((a, b) => normalize(b.alias).length - normalize(a.alias).length),
    doctors:[...doctors].sort((a, b) => b.length - a.length),
    departments:[...departments].sort((a, b) => b.length - a.length),
    concerns:[...CONCERN_TERMS]
  };
  catalogCache = { records:knowledgeRecords, catalog };
  return catalog;
}

const nonOverlappingEntities = (message, entries, valueFor) => {
  const query = normalize(message);
  const matches = [];
  const occupied = [];
  for (const entry of entries) {
    const alias = normalize(valueFor(entry));
    if (alias.length < 2) continue;
    let start = query.indexOf(alias);
    while (start >= 0) {
      const end = start + alias.length;
      if (!occupied.some((range) => start < range.end && end > range.start)) {
        occupied.push({ start, end });
        matches.push({ entry, alias:valueFor(entry), start, end });
      }
      start = query.indexOf(alias, start + 1);
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.alias.length - a.alias.length);
};

const extractEntities = (message, catalog) => {
  const projectMatches = nonOverlappingEntities(message, catalog.projects, (entry) => entry.alias);
  const doctorMatches = nonOverlappingEntities(message, catalog.doctors, (entry) => entry);
  const departmentMatches = nonOverlappingEntities(message, catalog.departments, (entry) => entry);
  const projects = unique(projectMatches.map((match) => match.entry.canonical));
  const doctors = unique(doctorMatches.map((match) => match.entry));
  const namedDoctor = extractNamedDoctorName(message);
  if (namedDoctor && catalog.doctors.includes(namedDoctor) && !doctors.includes(namedDoctor)) doctors.unshift(namedDoctor);
  const understanding = understandConcern(message, catalog.concerns);
  const concerns = understanding.concerns;
  const quoted = [...String(message).matchAll(/[“”"']([^“”"']{2,40})[“”"']/g)].map((match) => match[1]);
  return {
    projects,
    project_mentions:projectMatches.map((match) => ({ canonical:match.entry.canonical, mention:match.alias })),
    doctors,
    doctor_mentions:doctorMatches.map((match) => match.alias),
    departments:unique(departmentMatches.map((match) => match.entry)),
    concerns,
    concern_understanding:understanding,
    quoted_terms:unique(quoted),
    body_parts:unique([
      /(?:脸|面部|下颌|颧骨)/.test(message) || understanding.facial ? "面部" : "",
      /(?:眼|眼袋|泪沟|眉)/.test(message) ? "眼部" : "",
      /(?:鼻|鼻梁|鼻尖|鼻翼)/.test(message) ? "鼻部" : "",
      /(?:胸|乳房)/.test(message) ? "胸部" : "",
      /(?:腰|腹|腿|手臂|臀)/.test(message) ? "身体" : ""
    ])
  };
};

const dialogueActsFor = (message = "") => {
  const text = String(message);
  return unique([
    /^(?:你好|您好|你好呀|您好呀|嗨|哈喽|hello|hi|hey|在吗)[呀啊呢～~！!。，,\s]*$/i.test(text.trim()) ? "greet" : "",
    /^(?:好的?|嗯+|哦+|知道了|明白了|谢谢(?:你|您)?|不客气|先这样|我先看看|我考虑一下)[呀啊哦呢～~！!。.，,\s]*$/.test(text.trim()) ? "acknowledge" : "",
    /(?:区别|对比|比较|怎么选|哪个好|更好)/.test(text) ? "compare" : "",
    /(?:水滴形|水滴型|解剖型|圆形|光面|微绒面|绒面|型号|假体形状)/.test(text) ? "product_attribute" : "",
    /(?:推荐|哪位|哪个|谁|找.*(?:医生|院长)|医生怎么选)/.test(text) ? "recommend" : "",
    /(?:介绍|了解|是什么|怎么样|擅长|方向)/.test(text) ? "inform" : "",
    /(?:价格|报价|多少钱|费用|收费|预算)/.test(text) ? "price" : "",
    /(?:活动|政策|套餐|优惠|赠品|有效|过期|限购|权益)/.test(text) ? "policy" : "",
    /(?:核验|确认|现在|当前|最新)/.test(text) ? "verify" : "",
    /(?:排班|出诊|坐诊|在院|可约|能约|号源|预约)/.test(text) && /(?:医生|院长|主任|专家|[一-龥]{2,4})/.test(text) ? "schedule" : "",
    /(?:帮我预约|我要预约|想预约|安排到院|约面诊)/.test(text) ? "book" : "",
    /(?:什么时候|哪天|周末|工作日|上午|下午)/.test(text) && /(?:预约|到院|面诊|有空)/.test(text) ? "ask_time" : "",
    /(?:目录|下面.*(?:哪些|有什么)|哪些(?:项目|项目或)?资料|有什么(?:项目|项目或)?资料|服务范围|明星(?:产品|项目)|爆款|热销)/.test(text) ? "navigate" : "",
    /(?:地址|怎么走|停车|营业时间|联系电话)/.test(text) ? "service" : "",
    /(?:案例|术前术后|术后照片|前后对比|对比(?:照|图)|效果图|客户.{0,4}照片|照片看看)/.test(text) ? "case_request" : "",
    /(?:自然|垂感|垂坠|柔软|挺拔|明显|保守|不夸张|恢复快)/.test(text) ? "preference" : "",
    /(?:恢复期?|术后|消肿|拆线|住院|休息几天|请假几天|多久(?:恢复|消肿|能上班|能工作|能运动))/.test(text) ? "recovery" : "",
    /(?:周[一二三四五六日天]|工作日|周末|上午|下午|晚上|下班后|本周|下周|今天|明天)/.test(text) ? "time_preference" : "",
    /^(?:是的?|对的?|要的?|需要|可以|行|好的?|麻烦|请|帮我)[，,。.!！\s]*(?:帮我|麻烦)?[，,。.!！\s]*(?:核验|确认|查一下|看看|继续)?[，,。.!！\s]*$/.test(text.trim()) ? "confirm" : "",
    /(?:那|刚才|这个|那个|他|她|继续|下一步)/.test(text) ? "followup" : ""
  ]);
};

const ngrams = (value = "") => {
  const text = normalize(value);
  const terms = new Set();
  for (let index = 0; index < text.length - 1; index += 1) terms.add(text.slice(index, index + 2));
  return terms;
};

const jaccard = (left, right) => {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};

const prototypeScores = (message) => {
  const query = ngrams(message);
  return Object.fromEntries(Object.entries(INTENT_PROTOTYPES).map(([intent, examples]) => [intent, Math.max(...examples.map((example) => jaccard(query, ngrams(example))))]));
};

const evidenceAvailability = (intent, entities, catalog) => {
  const route = INTENT_ONTOLOGY[intent]?.evidence_route;
  if (route === "doctor_profiles") return entities.doctors.length > 0 || entities.projects.length > 0 ? 1 : catalog.doctors.length ? 0.6 : 0;
  if (route === "approved_project_knowledge") return entities.projects.length > 0 || entities.concerns.length > 0 ? 1 : 0.5;
  if (["price_and_policy", "directory_overview", "appointment_service", "service_information", "contextual"].includes(route)) return 0.8;
  if (["none", "restricted_metadata_only"].includes(route)) return 1;
  return 0.5;
};

const riskIntentFor = (risk = {}) => {
  const categories = new Set((risk.matches || []).map((match) => match.category));
  if (categories.has("medical_emergency")) return "medical_emergency";
  if (categories.has("medical_safety")) return "medical_safety";
  if (categories.has("medical_boundary")) return "medical_suitability";
  if (categories.has("human_request")) return "human_handover_request";
  if (["privacy", "privacy_complaint", "complaint"].some((category) => categories.has(category))) return "privacy_or_complaint";
  return "security_or_compliance";
};

const confidenceBand = (score) => score >= 0.78 ? "high" : score >= 0.55 ? "medium" : "low";

export function recognizeAcquisitionIntent(message, options = {}) {
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const catalog = options.catalog || buildAcquisitionEntityCatalog(options.knowledgeRecords || []);
  const risk = options.risk || { decision:"allow", matches:[] };
  const extractedEntities = extractEntities(message, catalog);
  // “他/她”的指代只在同一会话已经确认医生时解析，且仅用于公开医生资料、
  // 海报或擅长方向；不会把泛指代词当成第三方客户信息。
  const contextDoctors = unique(Array.isArray(context.known_doctors) ? context.known_doctors.map(String) : []);
  const referencesKnownDoctor = !extractedEntities.doctors.length
    && contextDoctors.length > 0
    && /(?:他|她)(?:的|做|擅长|介绍|项目|丰胸|隆胸|胸部|海报|宣传|图片|图)/.test(String(message));
  let entities = referencesKnownDoctor
    ? { ...extractedEntities, doctors:contextDoctors.slice(0, 1), doctor_mentions:["会话已确认医生"] }
    : extractedEntities;
  const correction = resolveBreastMethodCorrection(message, context);
  const explicitOtherProject = extractedEntities.projects.some((project) => !/(?:胸|乳房|^自体脂肪$)/.test(project));
  const pendingChoiceResolution = correction || (explicitOtherProject
    ? { status:"not_pending", choice:null, selection:null }
    : resolvePendingChoice(message, context.pending_choice));
  const selectedChoice = pendingChoiceResolution.status === "selected" ? pendingChoiceResolution.selection : null;
  if (correction) {
    // Drop entities extracted from the negated half of the correction.
    entities = { ...entities, projects:[selectedChoice.project, breastProjectForMethod(normalizeBreastMethod(selectedChoice.breast_method))] };
  }
  if (selectedChoice?.project && !entities.projects.includes(selectedChoice.project)) {
    entities = { ...entities, projects:[selectedChoice.project, ...entities.projects] };
  }
  const activeBreastMethod = normalizeBreastMethod(selectedChoice?.breast_method)
    || (!explicitOtherProject ? normalizeBreastMethod(context.known_slots?.breast_method) : "");
  const activeBreastProject = breastProjectForMethod(activeBreastMethod);
  // 在已选“假体/自体脂肪”后，原理、流程、恢复及形态等都是对此项目的追问。
  // 将具体项目写入当前实体，既让意图可解释，也给检索、图谱和状态持久化同一个锚点。
  const followsActiveBreastProject = Boolean(activeBreastProject) && (
    Boolean(selectedChoice?.facet)
    || CONTEXTUAL_BREAST_FACET.test(String(message))
  );
  if (followsActiveBreastProject && !entities.projects.includes(activeBreastProject)) {
    entities = { ...entities, projects:[activeBreastProject, ...entities.projects] };
  }
  if (selectedChoice?.doctor && !entities.doctors.includes(selectedChoice.doctor)) {
    entities = { ...entities, doctors:[selectedChoice.doctor, ...entities.doctors], doctor_mentions:["待选择医生"] };
  }
  const dialogueActs = dialogueActsFor(message);
  const prototypes = prototypeScores(message);
  const candidates = new Map();
  const add = (intent, baseScore, reasons = []) => {
    const semantic = prototypes[intent] || 0;
    const evidence = evidenceAvailability(intent, entities, catalog);
    const score = clamp(baseScore + semantic * 0.12 + evidence * 0.05);
    const current = candidates.get(intent);
    if (!current || score > current.score) candidates.set(intent, { intent, score, semantic_score:Number(semantic.toFixed(4)), evidence_score:evidence, reason_codes:unique(reasons) });
  };

  if (risk.decision !== "allow") {
    const primaryIntent = riskIntentFor(risk);
    const ontology = INTENT_ONTOLOGY[primaryIntent];
    return {
      version:INTENT_ENGINE_VERSION,
      primary_intent:primaryIntent,
      secondary_intents:[],
      domain:ontology.domain,
      dialogue_act:"risk_signal",
      entities,
      risk:{ decision:risk.decision, matches:risk.matches || [], safety_override:true },
      confidence:1,
      confidence_band:"high",
      clarification_required:false,
      reason_codes:["deterministic_safety_override"],
      candidate_intents:[{ intent:primaryIntent, score:1, reason_codes:["deterministic_safety_override"] }],
      evidence_plan:{ route:ontology.evidence_route, access:"none", filters:{} },
      next_action:ontology.action,
      current_turn_overrides_context:true
    };
  }

  const acts = new Set(dialogueActs);
  if (selectedChoice?.intent) {
    add(selectedChoice.intent, 0.995, ["pending_choice_selected", `choice_field_${pendingChoiceResolution.choice.field}`, `choice_value_${selectedChoice.value}`]);
  }
  if (acts.has("greet")) add("conversation_greeting", 0.99, ["standalone_greeting_act"]);
  if (acts.has("acknowledge")) add("conversation_acknowledgement", 0.98, ["short_acknowledgement_act"]);
  if (acts.has("case_request")) add("case_request_restricted", 0.94, ["case_request_phrase", "restricted_source_policy"]);
  if (acts.has("product_attribute")) add("product_attribute_verification", 0.96, ["product_attribute_act", "current_source_verification_required"]);
  if (entities.doctors.length >= 2 && acts.has("compare")) add("doctor_comparison", 0.92, ["multiple_doctor_entities", "comparison_act"]);
  if (entities.doctors.length && acts.has("schedule")) add("doctor_schedule_verification", 0.94, ["doctor_entity", "schedule_act"]);
  if (entities.doctors.length) add("doctor_profile", acts.has("inform") ? 0.91 : 0.86, ["named_doctor_entity"]);
  if (!entities.doctors.length && isDoctorRecommendationIntent(message)) {
    add("doctor_discovery_by_project", entities.projects.length ? 0.94 : 0.61, ["doctor_recommendation_act", entities.projects.length ? "project_entity" : "missing_project_entity"]);
  }
  if (acts.has("price")) add("price_verification", 0.9, ["price_act", entities.projects.length ? "project_entity" : "context_may_supply_project"]);
  if (acts.has("policy")) add("policy_verification", 0.91, ["policy_act", acts.has("verify") ? "verification_act" : ""]);
  if (acts.has("navigate")) add("directory_discovery", 0.97, ["navigation_act"]);
  if (acts.has("book")) add("appointment_request", 0.92, ["booking_act"]);
  else if (acts.has("ask_time")) add("appointment_query", 0.86, ["appointment_time_act"]);
  if (acts.has("service")) add("service_information", 0.92, ["service_information_act"]);
  const explicitComparison = acts.has("compare") && (
    entities.projects.length >= 2
    || entities.project_mentions.length >= 2
    || (/(?:假体)/.test(message) && /(?:自体脂肪|脂肪)/.test(message))
  );
  if (explicitComparison) add("project_comparison", 0.96, ["multiple_project_mentions", "comparison_act"]);
  if (entities.projects.length) add("project_explanation", acts.has("inform") ? 0.83 : 0.69, ["project_entity"]);
  if (!entities.projects.length && entities.concerns.length) add("project_discovery_by_concern", 0.82, ["concern_entity", "missing_explicit_project"]);

  const contextProjects = unique([
    ...(Array.isArray(context.interests) ? context.interests.map((item) => typeof item === "string" ? item : item?.name) : []),
    ...(Array.isArray(context.known_projects) ? context.known_projects : [])
  ]);
  const recentNamedProjects = unique([...(context.recent_turns || [])].reverse().filter(turn=>turn.role === 'user').flatMap(turn=>extractEntities(turn.content || '',catalog).project_mentions.map(item=>item.mention))).slice(0,2);
  const comparisonReferences = recentNamedProjects.length === 2 ? recentNamedProjects : contextProjects;
  if (!entities.projects.length && !entities.doctors.length && /这两|那两|两者|它们|二者/.test(message) && /区别|差别|不同|对比|比较/.test(message) && comparisonReferences.length === 2) {
    entities = {...entities, projects:[...comparisonReferences], resolved_reference:'two_projects'};
    add('project_comparison', .995, ['two_project_reference_resolved']);
  }
  // Short answers to our own facet question retain the selected project.
  const requestedFacet = /^(?:我想|想|先|了解|了解一下|讲讲|说说|那|就|看看|介绍一下|它的|这个的|的|吧|呢|好|嗯|，|,|\s)*(?:一般原理|基本原理|原理|作用原理|怎么起作用|怎么起效)(?:吧|呢|是什么|是啥|[？?。！!\s])*$/u.test(message) ? 'principle'
    : /^(?:我想|想|先|了解|了解一下|那|就|看看|的|吧|呢|，|,|\s)*(?:恢复安排|恢复期|恢复时间)(?:吧|呢|多久|[？?。！!\s])*$/u.test(message) ? 'recovery' : '';
  if(requestedFacet && !entities.projects.length && !entities.doctors.length && contextProjects.length===1) {
    entities={...entities,projects:[contextProjects[0]],requested_facet:requestedFacet};
    add('conversation_followup',.99,['answer_to_project_facet_question','context_project_available']);
  }
  const lastIntent = String(context.last_intent || "").trim();
  const confirmedBreastMethod = normalizeBreastMethod(context.known_slots?.breast_method);
  const asksImplantShape = /(?:假体)?形态|有哪些形态|什么形态|圆形|水滴形|水滴型|解剖型/.test(String(message));
  if (confirmedBreastMethod === "implant" && asksImplantShape) {
    add("conversation_followup", 0.97, ["confirmed_breast_method_implant", "implant_shape_facet"]);
  }
  const breastTypeSelection = (normalizeBreastMethod(selectedChoice?.breast_method) || (isBreastTypeSelection(message) && hasBreastSelectionContext(context)));
  const priorDoctorSearch = lastIntent === "doctor_discovery_by_project"
    || (Array.isArray(context.recent_turns)
      && context.recent_turns.some((turn) => turn?.role === "user" && isDoctorRecommendationIntent(turn?.content)));
  if (priorDoctorSearch && breastTypeSelection) {
    add("doctor_discovery_by_project", 0.98, ["breast_type_selection", "prior_doctor_search"]);
  }
  const currentHasExplicitEntity = entities.projects.length > 0 || entities.doctors.length > 0 || acts.has("service") || acts.has("case_request") || Boolean(selectedChoice);
  if (!currentHasExplicitEntity && contextProjects.length && acts.has("recovery")) {
    add("conversation_followup", 0.94, ["recovery_facet_act", "context_project_available"]);
  }
  if (!currentHasExplicitEntity && contextProjects.length && acts.has("time_preference")) {
    add("appointment_query", 0.95, ["contextual_time_preference", "context_project_available"]);
  }
  const confirmCarryIntents = new Set([
    "price_verification", "policy_verification"
  ]);
  if (!currentHasExplicitEntity && contextProjects.length && lastIntent === "price_verification" && /(?:核验|确认|现在|当前)/.test(message)) {
    add("price_verification", 0.97, ["current_price_verification", "last_intent_continuation", "context_project_available"]);
  }
  if (!currentHasExplicitEntity && contextProjects.length && acts.has("confirm") && !acts.has("time_preference")) {
    if (confirmCarryIntents.has(lastIntent)) {
      add(lastIntent, 0.95, ["explicit_confirmation", "last_intent_continuation", "context_project_available"]);
    } else {
      add("conversation_followup", 0.82, ["explicit_confirmation", "context_project_available"]);
    }
  }
  if (!currentHasExplicitEntity && (acts.has("followup") || acts.has("preference")) && contextProjects.length) {
    add("conversation_followup", acts.has("preference") ? 0.84 : 0.76, [acts.has("preference") ? "preference_act" : "followup_act", "context_project_available"]);
  }
  if (!candidates.size) add("need_clarification", contextProjects.length ? 0.58 : 0.72, [contextProjects.length ? "context_available_but_task_ambiguous" : "no_supported_entity_or_act"]);

  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  const primary = sorted[0];
  const ontology = INTENT_ONTOLOGY[primary.intent];
  const clarificationRequired = primary.score < 0.55
    || (primary.intent === "doctor_discovery_by_project" && !entities.projects.length)
    || (primary.intent === "need_clarification");
  const filters = {
    ...(entities.projects.length ? { projects:entities.projects } : {}),
    ...(entities.doctors.length ? { doctors:entities.doctors } : {}),
    ...(entities.departments.length ? { departments:entities.departments } : {}),
    ...(entities.concerns.length ? { concerns:entities.concerns } : {}),
    ...(breastTypeSelection ? { doctor_project_group:"breast", breast_method_selection:true } : {}),
    ...(followsActiveBreastProject ? { active_breast_method:activeBreastMethod, active_breast_project:activeBreastProject } : {}),
    ...(!breastTypeSelection && doctorProjectGroupFor(message) ? { doctor_project_group:doctorProjectGroupFor(message).id } : {}),
    ...(selectedChoice ? { pending_choice_field:pendingChoiceResolution.choice.field, pending_choice_value:selectedChoice.value } : {})
  };
  return {
    version:INTENT_ENGINE_VERSION,
    primary_intent:primary.intent,
    secondary_intents:sorted.slice(1, 3).filter((item) => primary.score - item.score <= 0.18).map((item) => item.intent),
    domain:ontology.domain,
    dialogue_act:dialogueActs[0] || "inform",
    dialogue_acts:dialogueActs,
    entities,
    risk:{ decision:"allow", matches:[], safety_override:false },
    confidence:Number(primary.score.toFixed(4)),
    confidence_band:confidenceBand(primary.score),
    clarification_required:clarificationRequired,
    reason_codes:primary.reason_codes,
    candidate_intents:sorted.slice(0, 5).map((item) => ({ ...item, score:Number(item.score.toFixed(4)) })),
    evidence_plan:{ route:ontology.evidence_route, access:ontology.evidence_route === "restricted_metadata_only" ? "metadata_only" : "public_safe", filters },
    next_action:clarificationRequired ? "ask_one_clarifying_question" : ontology.action,
    current_turn_overrides_context:currentHasExplicitEntity && !breastTypeSelection && !selectedChoice,
    context_used:Boolean(selectedChoice) || breastTypeSelection || followsActiveBreastProject || (!currentHasExplicitEntity && contextProjects.length > 0),
    context_projects:contextProjects,
    choice_resolution:{
      status:pendingChoiceResolution.status,
      ...(pendingChoiceResolution.choice ? { field:pendingChoiceResolution.choice.field } : {}),
      ...(selectedChoice ? { selection:selectedChoice, matched_by:pendingChoiceResolution.matched_by } : {})
    }
  };
}

export function getIntentEngineStatus(knowledgeRecords = []) {
  const catalog = buildAcquisitionEntityCatalog(knowledgeRecords);
  return {
    version:INTENT_ENGINE_VERSION,
    intents:Object.keys(INTENT_ONTOLOGY).length,
    project_aliases:catalog.projects.length,
    doctor_entities:catalog.doctors.length,
    departments:catalog.departments.length,
    concern_entities:catalog.concerns.length,
    algorithm:"deterministic_rules+entity_linking+prototype_similarity+evidence_validation+pending_choice_slot_resolution+context_resolution"
  };
}

export const resetIntentCatalogForTest = () => { catalogCache = { records:null, catalog:null }; };
