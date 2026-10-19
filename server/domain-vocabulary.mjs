import { createHash } from "node:crypto";
import { buildAcquisitionEntityCatalog } from "./acquisition-intent.mjs";

const REVIEWED_COLLOQUIAL_REWRITES = Object.freeze([
  { pattern:/(?:做胸|丰胸|美胸|乳房整形)/, canonical:["胸部整形", "隆胸"] },
  { pattern:/(?:隆鼻|鼻综合|鼻修复)/, canonical:["鼻部整形", "隆鼻"] },
  { pattern:/(?:双眼皮|重睑|眼综合)/, canonical:["眼部整形", "双眼皮"] },
  { pattern:/(?:去眼袋|祛眼袋)/, canonical:["眼部整形", "祛眼袋"] },
  { pattern:/(?:拉皮|微拉美)/, canonical:["面部年轻化", "拉皮", "微拉美"] },
  { pattern:/(?:抗衰|抗初老)/, canonical:["面部年轻化", "抗初老"] },
  { pattern:/(?:打肉毒|肉毒素|瘦脸针)/, canonical:["注射瘦脸", "肉毒"] },
  { pattern:/(?:水光针|水光)/, canonical:["皮肤美容", "水光"] },
  { pattern:/(?:光子嫩肤|光子)/, canonical:["皮肤美容", "光子嫩肤"] },
  { pattern:/(?:点痣|祛痣|去痣)/, canonical:["点痣", "CO2激光点痣", "色素痣"] },
  { pattern:/(?:吸脂|抽脂)/, canonical:["吸脂塑形"] },
  { pattern:/(?:植发|发际线)/, canonical:["毛发移植"] }
]);

const REVIEWED_FACET_REWRITES = Object.freeze([
  { pattern:/(?:多少钱|价格|价钱|价位|报价|费用|收费|预算)/, canonical:["价格", "费用"] },
  { pattern:/(?:恢复期?|术后|拆线|消肿|住院|休息多久)/, canonical:["恢复", "恢复期", "术后"] },
  { pattern:/(?:风险|副作用|并发症|禁忌|安全吗)/, canonical:["风险", "副作用"] },
  { pattern:/(?:流程|步骤|怎么做|手术方式|麻醉)/, canonical:["流程", "步骤"] },
  { pattern:/(?:材料|材质|品牌|型号|假体形状|光面|绒面|水滴)/, canonical:["材料", "品牌", "型号"] },
  { pattern:/(?:排班|出诊|坐诊|在院|周末|预约)/, canonical:["排班", "出诊", "预约"] },
  { pattern:/(?:擅长|专业方向|资质|职称)/, canonical:["擅长", "专业方向"] },
  { pattern:/(?:优惠|活动|套餐|权益|政策)/, canonical:["优惠", "套餐", "权益", "政策"] }
]);

const PRODUCT_OR_INSTRUMENT = /(?:假体|玻尿酸|肉毒|超声|射频|激光|水光|皮秒|光子|线材|仪器|品牌)/;
const SAFE_TERM = /^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9_.+·®™()/-]{1,39}$/;
const clean = (value) => String(value || "").normalize("NFKC").trim();
const hashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const addTerm = (terms, term, type, source = "") => {
  const value = clean(term);
  if (!value || value.length < 2 || value.length > 40 || !SAFE_TERM.test(value)
    || /\.(?:jpe?g|png|webp|gif|pdf|docx?|xlsx?|pptx?)$/i.test(value)) return;
  const existing = terms.get(value) || { term:value, type, sources:new Set(), aliases:new Set(), aliasAllowed:true };
  existing.sources.add(source || type);
  terms.set(value, existing);
};

const addAlias = (terms, canonical, alias, type, source = "") => {
  addTerm(terms, canonical, type, source);
  addTerm(terms, alias, type, source);
  const existing = terms.get(clean(canonical));
  if (existing) existing.aliases.add(clean(alias));
};

export function buildDomainVocabulary(knowledgeState = {}, { releaseId = null, indexVersion = null } = {}) {
  const records = Array.isArray(knowledgeState.publicRecords)
    ? knowledgeState.publicRecords
    : Array.isArray(knowledgeState.records) ? knowledgeState.records : [];
  const catalog = buildAcquisitionEntityCatalog(records);
  const terms = new Map();

  for (const entry of catalog.projects || []) {
    addAlias(terms, entry.canonical, entry.alias, "project", entry.source);
  }
  const doctorNames = catalog.doctors || [];
  const titledDoctors = doctorNames.filter((name) => /(?:技术院长|院长|主任|医生|专家)/.test(name));
  for (const full of titledDoctors) {
    addTerm(terms, full, "doctor", "doctor_directory");
    const bare = String(full).replace(/\s*(?:技术院长|院长|主任|医生|专家)$/u, "").trim();
    const item = terms.get(clean(full));
    if (item && bare.length >= 2 && bare !== full) {
      item.aliases.add(bare);
      item.aliasAllowed = false;
    }
  }
  for (const name of doctorNames) {
    if (titledDoctors.includes(name)) continue;
    const containingFull = titledDoctors.find((full) => full.includes(name));
    if (containingFull) {
      // A whitespace title (for example "李帅华 技术院长") is split by the
      // retrieval-service allowlist into safe catalog tokens. A no-space
      // honorific ("张群院长") remains a single approved token and the bare
      // name stays an alias only.
      if (/\s/u.test(containingFull)) addTerm(terms, name, "doctor", "doctor_directory");
      continue;
    }
    addTerm(terms, name, "doctor", "doctor_directory");
  }
  for (const department of catalog.departments || []) addTerm(terms, department, "department", "knowledge_path");
  for (const concern of catalog.concerns || []) addTerm(terms, concern, "body_part", "intent_engine");

  for (const record of records) {
    const path = String(record.source_relative_path || "");
    const segments = path.split("/").filter(Boolean);
    const title = String(record.title || "");
    const tags = Array.isArray(record.tags) ? record.tags : [];
    for (const tag of tags) addTerm(terms, tag, "knowledge_tag", "knowledge_tag");
    for (const segment of segments) {
      if (/(?:政策|权益|活动|套餐)/.test(segment)) addTerm(terms, segment, "policy", "knowledge_path");
      if (PRODUCT_OR_INSTRUMENT.test(segment)) addTerm(terms, segment, "product_or_instrument", "knowledge_path");
    }
    if (segments[0] === "项目介绍" && segments.length >= 3) {
      addTerm(terms, segments[2], "project", "knowledge_path");
      if (segments[3]) addTerm(terms, segments[3], "project", "knowledge_path");
    }
    const titleMatch = title.match(/^(?:医疗美容项目|项目介绍)[：:]\s*(.+)$/);
    if (titleMatch) addTerm(terms, titleMatch[1], "project", "knowledge_title");
  }

  for (const group of REVIEWED_COLLOQUIAL_REWRITES) {
    for (const canonical of group.canonical) addTerm(terms, canonical, "reviewed_alias", "reviewed_colloquial");
  }
  for (const group of REVIEWED_FACET_REWRITES) {
    for (const canonical of group.canonical) addTerm(terms, canonical, "facet", "reviewed_facet");
  }

  const sortedTerms = [...terms.values()]
    .map((item) => ({
      term:item.term,
      type:item.type,
      sources:[...item.sources].sort(),
      aliases:[...item.aliases].sort(),
      alias_allowed:item.aliasAllowed !== false
    }))
    .sort((left, right) => left.term.localeCompare(right.term, "zh-CN"));
  const counts = sortedTerms.reduce((result, item) => {
    result[item.type] = (result[item.type] || 0) + 1;
    return result;
  }, {});
  const material = {
    knowledge_version:knowledgeState.version || null,
    catalog_version:catalog.version || null,
    release_id:releaseId,
    index_version:indexVersion,
    terms:sortedTerms
  };
  const hash = hashJson(material);
  return {
    version:`domain-vocab-v1-${hash.slice(0, 12)}`,
    hash,
    knowledge_version:knowledgeState.version || null,
    catalog_version:catalog.version || null,
    release_id:releaseId,
    index_version:indexVersion,
    record_count:records.length,
    term_count:sortedTerms.length,
    counts,
    terms:sortedTerms,
    allowed:new Set(sortedTerms
      .filter((item) => item.type !== "knowledge_tag")
      .flatMap((item) => [item.term, ...(item.alias_allowed === false ? [] : item.aliases)]))
  };
}

let cachedVocabulary = null;
let cachedVocabularyKey = "";

export function getDomainVocabulary(knowledgeState = {}, { releaseId = null, indexVersion = null } = {}) {
  const key = `${knowledgeState.version || ""}:${knowledgeState.packageChecksum || knowledgeState.manifestSha256 || ""}:${releaseId || ""}:${indexVersion || ""}:${knowledgeState.records?.length || knowledgeState.publicRecords?.length || 0}`;
  if (cachedVocabulary && cachedVocabularyKey === key) return cachedVocabulary;
  cachedVocabulary = buildDomainVocabulary(knowledgeState, { releaseId, indexVersion });
  cachedVocabularyKey = key;
  return cachedVocabulary;
}

export function rewriteDomainQuery(query = "", { context = {}, vocabulary = null } = {}) {
  const text = clean(query);
  const vocab = vocabulary || getDomainVocabulary();
  const tokens = new Set();
  const additions = [];
  const resolved = [];
  const push = (term, reason) => {
    const value = clean(term);
    if (!value || !vocab.allowed?.has(value) || tokens.has(value)) return;
    tokens.add(value);
    additions.push({ term:value, reason });
  };

  for (const item of vocab.terms) {
    if (item.type === "project" || item.type === "doctor") {
      for (const alias of [item.term, ...item.aliases]) {
        if (text.includes(alias)) push(item.term, item.type === "doctor" ? "doctor_alias" : "project_alias");
      }
    }
  }
  for (const group of REVIEWED_COLLOQUIAL_REWRITES) {
    if (group.pattern.test(text)) for (const term of group.canonical) push(term, "colloquial_rewrite");
  }
  for (const group of REVIEWED_FACET_REWRITES) {
    if (group.pattern.test(text)) for (const term of group.canonical) push(term, "facet_rewrite");
  }
  const knownDoctors = Array.isArray(context.known_doctors) ? context.known_doctors.filter(Boolean) : [];
  const knownProjects = Array.isArray(context.known_projects) ? context.known_projects.filter(Boolean) : [];
  const resolveAllowed = (value, type) => {
    const textValue = clean(value);
    if (vocab.allowed?.has(textValue)) return textValue;
    const candidate = vocab.terms
      .filter((item) => item.type === type
        && (item.term.includes(textValue) || item.aliases.some((alias) => alias.includes(textValue))))
      .sort((left, right) => right.term.length - left.term.length)[0];
    return candidate?.term || "";
  };
  if (/(?:那个|这位|这位|该)(?:医生|院长|专家)|(?:他|她)(?:擅长|怎么)/.test(text) && knownDoctors.length === 1) {
    const doctor = resolveAllowed(knownDoctors[0], "doctor");
    if (doctor) {
      push(doctor, "conversation_doctor_resolution");
      resolved.push({ entity:"doctor", value:doctor, source:"conversation" });
    }
  }
  if (/(?:那个|这个|该)(?:项目|疗程)|(?:它)(?:原理|恢复|价格)/.test(text) && knownProjects.length === 1) {
    const project = resolveAllowed(knownProjects[0], "project");
    if (project) {
      push(project, "conversation_project_resolution");
      resolved.push({ entity:"project", value:project, source:"conversation" });
    }
  }
  return {
    version:vocab.version,
    query:[...tokens].slice(0, 16).join(" "),
    tokens:[...tokens].slice(0, 16),
    additions,
    resolved
  };
}
