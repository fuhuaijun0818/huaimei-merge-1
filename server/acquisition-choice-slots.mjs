export const CHOICE_SLOT_VERSION = "1.1.0";

const MAX_OPTIONS = 8;
const MAX_ALIASES = 12;
const normalize = (value = "") => String(value).normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");
const unique = (values) => [...new Set(values.filter(Boolean))];
const clone = (value) => JSON.parse(JSON.stringify(value));

const slotDefinitions = {
  breast_method:{
    label:"丰胸方式",
    options:[
      { value:"implant", label:"假体丰胸", aliases:["假体", "假体方式", "假体丰胸", "假体隆胸"], intent:"project_explanation", project:"胸部整形", breast_method:"implant" },
      { value:"autologous_fat", label:"自体脂肪丰胸", aliases:["自体脂肪", "自体脂肪方式", "自体脂肪丰胸", "自体脂肪隆胸", "脂肪方式", "脂肪丰胸", "脂肪隆胸"], intent:"project_explanation", project:"胸部整形", breast_method:"fat" }
    ]
  },
  service_entry:{
    label:"服务事项",
    options:[
      { value:"project_consultation", label:"咨询医美项目", aliases:["咨询医美项目", "咨询项目", "项目咨询", "医美项目", "1", "第一个"], intent:"need_clarification" },
      { value:"consultation_process", label:"了解面诊流程", aliases:["了解面诊流程", "面诊流程", "2", "第二个"], intent:"consultation_process" }
    ]
  },
  project_information_facet:{
    label:"项目了解重点",
    options:[
      { value:"general_principle", label:"一般原理", aliases:["一般原理", "原理", "第一个", "1"], intent:"project_explanation", facet:"general_principle" },
      { value:"recovery", label:"恢复安排", aliases:["恢复安排", "恢复", "恢复期", "第二个", "2"], intent:"conversation_followup", facet:"recovery" }
    ]
  },
  implant_information_facet:{
    label:"假体丰胸了解重点",
    options:[
      { value:"implant_shape", label:"假体形态", aliases:["假体形态", "形态", "有哪些形态", "什么形态", "圆形", "水滴形", "解剖型", "第一个", "1"], intent:"conversation_followup", facet:"implant_shape", project:"胸部整形", breast_method:"implant" },
      { value:"recovery", label:"恢复安排", aliases:["恢复安排", "恢复", "恢复期", "第二个", "2"], intent:"conversation_followup", facet:"recovery", project:"胸部整形", breast_method:"implant" }
    ]
  }
};

const normalizeOption = (option = {}, ordinal = 0) => {
  const value = String(option.value || "").trim().slice(0, 80);
  const label = String(option.label || value).trim().slice(0, 100);
  if (!value || !label) return null;
  return {
    value,
    label,
    aliases:unique([value, label, ...(Array.isArray(option.aliases) ? option.aliases : [])]
      .map((item) => String(item || "").trim().slice(0, 100)).filter(Boolean)).slice(0, MAX_ALIASES),
    ...(option.intent ? { intent:String(option.intent).slice(0, 80) } : {}),
    ...(option.project ? { project:String(option.project).slice(0, 80) } : {}),
    ...(option.doctor ? { doctor:String(option.doctor).slice(0, 40) } : {}),
    ...(option.breast_method ? { breast_method:String(option.breast_method).slice(0, 40) } : {}),
    ...(option.facet ? { facet:String(option.facet).slice(0, 80) } : {}),
    ordinal
  };
};

export const normalizePendingChoice = (choice) => {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
  const field = String(choice.field || "").trim().replace(/[^a-z0-9_\-]/gi, "").slice(0, 64);
  const options = (Array.isArray(choice.options) ? choice.options : [])
    .map((option, index) => normalizeOption(option, index + 1)).filter(Boolean).slice(0, MAX_OPTIONS);
  if (!field || options.length < 2) return null;
  return {
    version:CHOICE_SLOT_VERSION,
    field,
    label:String(choice.label || field).trim().slice(0, 100),
    options,
    created_at:choice.created_at || null,
    created_turn:Number.isFinite(Number(choice.created_turn))
      ? Math.max(1, Math.floor(Number(choice.created_turn)))
      : null,
    expires_after_turn:Number.isFinite(Number(choice.expires_after_turn))
      ? Math.max(1, Math.min(8, Number(choice.expires_after_turn)))
      : 3
  };
};

export const buildChoicePrompt = (field, extras = {}) => {
  const definition = slotDefinitions[field];
  if (!definition) return null;
  return normalizePendingChoice({ field, label:definition.label, options:definition.options, ...extras });
};

export const deriveChoicePrompt = (structured = {}) => {
  const explicit = normalizePendingChoice(structured.choice_prompt);
  if (explicit) return explicit;
  const questions = Array.isArray(structured.next_questions) ? structured.next_questions.join(" ") : "";
  if (/假体(?:丰胸|隆胸)?.{0,20}(?:还是|或).{0,20}自体脂肪|自体脂肪(?:丰胸|隆胸)?.{0,20}(?:还是|或).{0,20}假体/.test(questions)) {
    return buildChoicePrompt("breast_method");
  }
  if (/一般原理.{0,20}(?:还是|或).{0,20}恢复安排|恢复安排.{0,20}(?:还是|或).{0,20}一般原理/.test(questions)) {
    return buildChoicePrompt("project_information_facet");
  }
  if (/假体形态.{0,20}(?:还是|或).{0,20}恢复安排|恢复安排.{0,20}(?:还是|或).{0,20}假体形态/.test(questions)) {
    return buildChoicePrompt("implant_information_facet");
  }
  const serviceValues = new Set(Array.isArray(structured.next_questions) ? structured.next_questions : []);
  if (["咨询医美项目", "了解面诊流程"].every((item) => serviceValues.has(item))) {
    return buildChoicePrompt("service_entry");
  }
  const doctors = Array.isArray(structured.doctor_candidates) ? structured.doctor_candidates : [];
  if (doctors.length >= 2 && /哪位医生|哪位院长|医生的介绍/.test(questions)) {
    return normalizePendingChoice({
      field:"doctor_candidate",
      label:"医生选择",
      options:doctors.slice(0, MAX_OPTIONS).map((doctor) => ({
        value:doctor.name,
        label:`${doctor.name}院长`,
        aliases:[doctor.name, `${doctor.name}医生`, `${doctor.name}院长`],
        intent:"doctor_profile",
        doctor:doctor.name
      }))
    });
  }
  return null;
};

const ordinalOption = (text, options) => {
  const indexMap = [[/第(?:1|一)(?:个|位|项)?|^1$/, 0], [/第(?:2|二)(?:个|位|项)?|^2$/, 1], [/第(?:3|三)(?:个|位|项)?|^3$/, 2], [/第(?:4|四)(?:个|位|项)?|^4$/, 3]];
  const match = indexMap.find(([pattern]) => pattern.test(text));
  return match && options[match[1]] ? options[match[1]] : null;
};

export const resolvePendingChoice = (message, pendingChoice) => {
  const choice = normalizePendingChoice(pendingChoice);
  if (!choice) return { status:"not_pending", choice:null, selection:null };
  const raw = String(message || "").trim();
  const text = normalize(raw);
  if (!text) return { status:"unmatched", choice, selection:null };
  if (/(?:都不要|都不选|不选了|算了|没想好|先不选)/.test(raw)) return { status:"cancelled", choice, selection:null };
  // Negated ordinals must not select an option merely because they contain
  // “第二个”. Resolve an explicit replacement before ordinary alias matching.
  const replacement = raw.match(/(?:不是|不要|不选).+?(?:而是|改成|换成|[,，；;]\s*是)(.+)$/)?.[1];
  if (replacement) return resolvePendingChoice(replacement, choice);
  if (/(?:不是|不要|不选|不想选)\s*(?:第?[一二三四1234](?:个|种|位|项)?)/.test(raw)) {
    return { status:"ambiguous", choice, selection:null };
  }
  const ordinal = ordinalOption(text, choice.options);
  if (ordinal) return { status:"selected", choice, selection:clone(ordinal), matched_by:"ordinal" };
  const matched = choice.options.filter((option) => option.aliases.some((alias) => {
    const token = normalize(alias);
    return token.length >= 2 && text.includes(token) && !new RegExp(`(?:不要|不选|不是|不想|别要)${token}`).test(text);
  }));
  if (matched.length === 1) return { status:"selected", choice, selection:clone(matched[0]), matched_by:"alias" };
  return { status:matched.length > 1 ? "ambiguous" : "unmatched", choice, selection:null };
};

// A correction remains meaningful after the original method selector was
// consumed (the current pending question may concern recovery or materials).
// The short word “脂肪” is only resolved within an established breast topic.
export const resolveBreastMethodCorrection = (message, context = {}) => {
  const raw = String(message || "").normalize("NFKC").trim();
  if (!/(?:不是|不要|不选|改成|换成|说错|更正)/.test(raw)) return null;
  if (/(?:鼻|面部|脸|下巴|臀)/.test(raw)) return null;
  const topics = [raw, ...(context.known_projects || []), ...(context.interests || []).map((item) => typeof item === "string" ? item : item?.name)].join(" ");
  if (!/(?:胸|乳房)/.test(topics)) return null;
  const replacement = raw.match(/(?:不是|不要|不选).+?(?:而是|[,，；;]\s*是|是)(.+)$/)?.[1]
    || raw.match(/(?:改成|换成|更正为)\s*(.+)$/)?.[1];
  if (!replacement) return null;
  const fat = /(?:自体脂肪|脂肪)/.test(replacement);
  const implant = /假体/.test(replacement);
  if (fat === implant || /(?:不是|不要|不选)/.test(replacement)) return null;
  const choice = buildChoicePrompt("breast_method");
  return { status:"selected", choice, selection:clone(choice.options[fat ? 1 : 0]), matched_by:"explicit_correction" };
};
