export const ACQUISITION_CONVERSATION_STYLE_VERSION = "2.3.0";

export const ACQUISITION_REPLY_SEGMENT_MAX_CHARACTERS = 36;

export const ACQUISITION_DIALOGUE_STAGES = Object.freeze({
  NEED_DISCOVERY:"need_discovery",
  KNOWLEDGE_EXPLANATION:"knowledge_explanation",
  DECISION_SUPPORT:"decision_support",
  APPOINTMENT_COORDINATION:"appointment_coordination",
  ARRIVAL_PREPARATION:"arrival_preparation",
  EXPERT_HANDOFF:"expert_handoff"
});

export const ACQUISITION_CONVERSATION_STYLE = Object.freeze({
  source_sample_count:6,
  source_asset_count:36,
  source_type:"真人售前微信聊天截图",
  transferable_features:[
    "先回应客户刚问的问题，再补充理由",
    "用简短确认承接客户信息，不重复整段复述",
    "每轮只推进一个关键问题",
    "把抽象追问改成两到三个具体选项",
    "记住已确认的项目、医生、时间和偏好，不重复询问",
    "根据需求了解、知识说明、决策比较、预约协调逐步推进",
    "重要安排给出清楚的下一步",
    "先提供有效信息，再在客户有行动意向时提供人工入口",
    "用案例、医生或价格资料时只解释与当前问题有关的部分"
  ],
  excluded_features:[
    "根据照片或视频判断问题",
    "在线给出个体适用性、术式或麻醉建议",
    "使用未经核验的价格、活动、排班或号源",
    "用案例暗示客户可获得同等效果",
    "使用绝对化医生、效果或安全宣传",
    "在无必要时收集年龄、病史或既往治疗等敏感信息",
    "默认使用宝宝、亲爱的、美女等过度亲密称呼",
    "每轮固定使用可以的、好的呢、嗯呢等口头禅",
    "客户尚未表现行动意向时催促留手机号"
  ],
  response_contract:{
    answer_first:true,
    max_questions:1,
    preferred_sentences:"2-4",
    preferred_characters:"45-260",
    preferred_sentence_characters:"8-32",
    max_segment_characters:ACQUISITION_REPLY_SEGMENT_MAX_CHARACTERS,
    segmented_messages:true,
    preferred_structure:["直接回答或自然承接", "简短依据或边界", "一个下一步问题（确有必要时）"],
    avoid_repeated_greeting:true,
    avoid_markdown:true,
    avoid_internal_language:true,
    optional_next_question:true,
    lead_capture_after_value:true
  }
});

export const ACQUISITION_CONVERSATION_STYLE_PROMPT = `
售前沟通采用真人顾问的渐进式节奏：
- 先回答客户这一轮真正问的内容，再补一句必要依据或边界；不要先写背景、免责声明或自我介绍。
- 一次回复以2到4个短句为主，通常45到220字。每句尽量控制在8到32字，不要把多个意思塞进一个长句。
- 每个短句都要能独立作为一条聊天消息展示。直接答案、补充说明、必要边界和追问分别成句，不要用连续逗号把它们串成长段。
- 每轮最多问一个关键问题，而且只有对下一步有帮助时才问；客户只是确认或致谢时，可以不追问。
- 已确认的项目、医生、预算、时间和偏好要自然承接，不复述整段历史，也不重复询问。
- “可以的、好的呢、嗯呢、明白”都不是固定开场。事实问题直接给答案；只有明确预约、执行请求或客户做出选择时，才偶尔用“好的、我先按这个方向帮您整理”等承接。
- 不默认使用“宝宝、亲爱的、美女”等亲密称呼，不模仿错别字，不堆表情。
- 需求了解阶段只确认一个重点；知识说明阶段给直接答案；比较阶段围绕客户最在意的一项比较；预约阶段确认日期或上午/下午；不要跨阶段催成交。
- 不主动催促留手机号。先完成当前问答，只有客户明确要求人工、预约、核价、查排班，或连续多轮已进入决策阶段时，页面才会提供人工协助入口。
- 项目、医生、价格等资料只解释与当前问题直接相关的内容，不一次罗列所有卡片或候选项。
- 必要的“需医生面诊、需核验”融入答案且只说一次，不连续堆叠同义免责声明。
- 不得为了在线判断客户是否适合某项目，追问脂肪量、皮肤松弛程度、病史等个体身体信息；这类判断交由医生面诊。
- 输出纯文本，不使用Markdown标题、加粗符号或编号式长报告。
`.trim();

const INTERNAL_LANGUAGE = /知识库|资料库|检索(?:结果|记录|内容|命中)?|命中(?:结果|记录|内容)?|本地规则草稿|系统上下文|提示词|内部实现/;
const ROBOTIC_PREAMBLE = /^(?:您好[！!，,。\s]*|关于您提到的内容[，,：:]?|根据(?:以上|上述|系统|相关资料)[，,：:]?|综上所述[，,：:]?)/;
const FACT_FIRST_INTENTS = new Set([
  "project_explanation", "project_comparison", "doctor_profile", "doctor_comparison",
  "product_attribute_verification",
  "doctor_discovery_by_project", "doctor_schedule_verification", "price_verification",
  "policy_verification", "service_information", "directory_discovery", "knowledge_grounded_explanation"
]);
const APPOINTMENT_INTENTS = new Set(["appointment_query", "appointment_request"]);
const DECISION_INTENTS = new Set([
  "project_comparison", "doctor_comparison", "doctor_discovery_by_project", "doctor_schedule_verification",
  "price_verification", "policy_verification", "product_attribute_verification"
]);
const ACKNOWLEDGEMENT_OPENING = /^(?:可以的|好的呢|好的|好呢|好哒|嗯呢|嗯嗯|明白了?|理解您|没问题|当然可以)[呀啊哦呢～~！!，,。\s]*/u;
const INTIMATE_ADDRESS = /(?:宝宝|宝贝|亲爱的|美女|小姐姐)/g;

const sentenceCount = (text = "") => String(text).split(/[。！？!?]+/).map((item) => item.trim()).filter(Boolean).length;
const acknowledgementToken = (text = "") => String(text).trim().match(ACKNOWLEDGEMENT_OPENING)?.[0]?.replace(/[呀啊哦呢～~！!，,。\s]/g, "") || "";

const sentenceUnits = (message = "") => String(message)
  .replace(/\r/g, "")
  .replace(/[ \t]+/g, " ")
  .trim()
  .match(/[^。！？!?；;\n]+(?:[。！？!?；;]+|\n+|$)/gu) || [];

const clauseUnits = (sentence = "") => String(sentence).match(/[^，,、：:]+(?:[，,、：:]+|$)/gu) || [String(sentence)];

const closeSegment = (segment = "") => String(segment)
  .trim()
  .replace(/[，,、：:；;]+$/u, "。");

/**
 * 把一轮答复转换为渠道无关的短消息数组。
 * 原始 reply 文本继续保留以兼容已有接入方；网页等聊天渠道优先消费 segments。
 */
export function splitAcquisitionReplySegments(message = "", options = {}) {
  const maxCharacters = Math.min(Math.max(Number(options.maxCharacters) || ACQUISITION_REPLY_SEGMENT_MAX_CHARACTERS, 32), 80);
  const units = sentenceUnits(message);
  if (!units.length) return [];
  const atomicSegments = [];

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const normalizedUnit = unit.trim();
    if (!normalizedUnit) continue;
    // 连续编号是同一组信息（例如服务范围），合并为一个气泡，避免逐项播报显得机械。
    if (/^\d+[.、]\s+\S/u.test(normalizedUnit)) {
      const numberedItems = [normalizedUnit];
      let cursor = index + 1;
      while (cursor < units.length && /^\d+[.、]\s+\S/u.test(String(units[cursor]).trim())) {
        numberedItems.push(String(units[cursor]).trim());
        cursor += 1;
      }
      const numberedGroup = numberedItems.join("\n");
      if (numberedGroup.length <= maxCharacters) {
        atomicSegments.push(numberedGroup);
        index = cursor - 1;
        continue;
      }
    }
    if (normalizedUnit.length <= maxCharacters) {
      atomicSegments.push(normalizedUnit);
      continue;
    }

    const unitSegments = [];
    let current = "";
    for (const clause of clauseUnits(normalizedUnit)) {
      const normalizedClause = clause.trim();
      if (!normalizedClause) continue;
      if (!current || current.length + normalizedClause.length <= maxCharacters) {
        current += normalizedClause;
        continue;
      }
      unitSegments.push(closeSegment(current));
      current = normalizedClause;
    }
    if (current) unitSegments.push(closeSegment(current));
    if (unitSegments.length > 1 && unitSegments.at(-1).length <= 8) {
      const tail = unitSegments.pop();
      unitSegments[unitSegments.length - 1] = `${unitSegments.at(-1).replace(/。$/u, "，")}${tail}`;
    }
    atomicSegments.push(...unitSegments);
  }

  // 普通说明中把两句相邻短句合为一个气泡，以换行保留短句节奏。编号和
  // 问句仍独立展示；包含原始换行的模板文案（例如欢迎语）保持既有分组。
  if (String(message).includes("\n")) return atomicSegments.filter(Boolean);
  const segments = [];
  // Keep sentence boundaries visible to web/IM adapters. Grouping two short
  // sentences made the real web channel return one segment despite the
  // channel contract promising a short message array.
  const groupLimit = Math.min(maxCharacters * 2, 64);
  for (const segment of atomicSegments.filter(Boolean)) {
    const previous = segments.at(-1);
    const canGroup = atomicSegments.length > 2
      && previous
      && !/[？?]$/.test(previous)
      && !/[？?]$/.test(segment)
      && !/^\d+[.、]\s+/u.test(previous)
      && !/^\d+[.、]\s+/u.test(segment)
      && previous.split("\n").length < 2
      && previous.length + segment.length + 1 <= groupLimit;
    if (canGroup) segments[segments.length - 1] = `${previous}\n${segment}`;
    else segments.push(segment);
  }
  return segments;
}

export function determineAcquisitionDialogueStage({ intent = "", status = "completed", context = {}, message = "" } = {}) {
  if (status === "handover_required" || /(?:人工|真人|顾问|医生回复)/.test(message)) return ACQUISITION_DIALOGUE_STAGES.EXPERT_HANDOFF;
  if (APPOINTMENT_INTENTS.has(intent) || /(?:预约|约面诊|安排到院|哪天到|什么时候到院)/.test(message)) return ACQUISITION_DIALOGUE_STAGES.APPOINTMENT_COORDINATION;
  if (intent === "service_information" && (context.known_slots?.time_preference || /(?:到了|到院|怎么走|地址|停车)/.test(message))) return ACQUISITION_DIALOGUE_STAGES.ARRIVAL_PREPARATION;
  if (DECISION_INTENTS.has(intent) || (Number(context.turn_index) >= 3 && (context.known_slots?.budget || context.known_slots?.time_preference))) return ACQUISITION_DIALOGUE_STAGES.DECISION_SUPPORT;
  if (["conversation_greeting", "need_clarification", "project_discovery_by_concern"].includes(intent)) return ACQUISITION_DIALOGUE_STAGES.NEED_DISCOVERY;
  return ACQUISITION_DIALOGUE_STAGES.KNOWLEDGE_EXPLANATION;
}

export function normalizeAcquisitionConversationCopy(message = "", options = {}) {
  const intent = String(options.intent || "");
  const recentTurns = Array.isArray(options.context?.recent_turns) ? options.context.recent_turns : [];
  const previousAssistant = [...recentTurns].reverse().find((turn) => turn?.role === "assistant")?.content || "";
  const previousOpening = acknowledgementToken(previousAssistant);
  const preserveGreeting = intent === "conversation_greeting";
  let text = String(message)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!preserveGreeting) text = text.replace(/^您好[！!，,。\s]*/u, "");

  const currentOpening = acknowledgementToken(text);
  if (FACT_FIRST_INTENTS.has(intent) || (currentOpening && currentOpening === previousOpening)) {
    text = text.replace(ACKNOWLEDGEMENT_OPENING, "");
  } else {
    text = text.replace(/^(?:可以的|可以)[。！，,\s]*/u, "");
  }
  return text
    .replace(INTIMATE_ADDRESS, "您")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function evaluateAcquisitionConversationCopy(message = "", options = {}) {
  const text = String(message).trim();
  const greetingIntent = String(options.intent || "") === "conversation_greeting";
  const approvedGreeting = /^(?:您好[！!，,\s]*(?:欢迎咨询)?上海华美医疗美容医院|我是上海华美医院顾问安安)/.test(text);
  const questionCount = (text.match(/[？?]/g) || []).length;
  // User-approved alternative invitation is two sentences forming one choice.
  const approvedInvitation = questionCount === 2 && text.endsWith("还有其他想了解的吗？或者帮您预约专家做进一步分析？");
  const paragraphCount = text ? text.split(/\n\s*\n/).length : 0;
  const acknowledgementCount = (text.match(/可以的|好的呢|嗯呢|嗯嗯|明白了?|理解您|没问题/g) || []).length;
  const hasIntimateAddress = /(?:宝宝|宝贝|亲爱的|美女|小姐姐)/.test(text);
  const reasonCodes = [
    text.length > 420 ? "too_long" : "",
    sentenceCount(text) > 7 ? "too_many_sentences" : "",
    questionCount > 1 && !approvedInvitation ? "too_many_questions" : "",
    paragraphCount > 4 ? "too_many_paragraphs" : "",
    acknowledgementCount > 1 ? "repeated_acknowledgement" : "",
    INTERNAL_LANGUAGE.test(text) ? "internal_language" : "",
    ROBOTIC_PREAMBLE.test(text) && !(greetingIntent || approvedGreeting) ? "robotic_preamble" : "",
    /\*\*|^\s*#{1,6}\s/m.test(text) ? "markdown_formatting" : "",
    /(?:请|建议您)(?:先)?留下(?:手机号|电话|联系方式)/.test(text) ? "premature_lead_push" : "",
    hasIntimateAddress ? "overfamiliar_address" : ""
  ].filter(Boolean);
  return {
    valid:reasonCodes.length === 0,
    version:ACQUISITION_CONVERSATION_STYLE_VERSION,
    reason_codes:reasonCodes,
    characters:text.length,
    sentence_count:sentenceCount(text),
    question_count:questionCount,
    paragraph_count:paragraphCount
  };
}

export function leadCaptureDecision({ intent = "", status = "completed", turnCount = 0, knownSlots = {}, message = "", recommendedActions = [] } = {}) {
  if (status === "blocked") return { should_prompt:false, reason:"blocked_response" };
  if (status === "handover_required") return { should_prompt:true, reason:"handover_required" };
  if (/(?:转人工|找人工|真人顾问|人工客服|联系我)/.test(message)) return { should_prompt:true, reason:"explicit_human_request" };
  if (APPOINTMENT_INTENTS.has(intent) || /(?:帮我预约|想预约|约面诊|安排到院)/.test(message)) return { should_prompt:true, reason:"appointment_intent" };
  if (/(?:核验|确认|查)(?:当前)?(?:价格|活动|排班|出诊|号源)/.test(message)) return { should_prompt:true, reason:"explicit_verification_request" };
  const actions = new Set((recommendedActions || []).map((item) => item?.type));
  const hasDecisionSignal = Boolean(knownSlots?.budget || knownSlots?.time_preference)
    || actions.has("offer_human_appointment")
    || actions.has("request_human_source_verification");
  if (turnCount >= 3 && DECISION_INTENTS.has(intent) && hasDecisionSignal) return { should_prompt:true, reason:"multi_turn_decision_stage" };
  return { should_prompt:false, reason:"continue_ai_conversation" };
}

export function getAcquisitionConversationStyleStatus() {
  return {
    version:ACQUISITION_CONVERSATION_STYLE_VERSION,
    source_sample_count:ACQUISITION_CONVERSATION_STYLE.source_sample_count,
    source_asset_count:ACQUISITION_CONVERSATION_STYLE.source_asset_count,
    transferable_features:ACQUISITION_CONVERSATION_STYLE.transferable_features.length,
    excluded_features:ACQUISITION_CONVERSATION_STYLE.excluded_features.length,
    answer_first:true,
    max_questions:1,
    max_segment_characters:ACQUISITION_REPLY_SEGMENT_MAX_CHARACTERS,
    segmented_messages:true,
    dialogue_stages:Object.keys(ACQUISITION_DIALOGUE_STAGES).length,
    lead_capture_after_value:true
  };
}
