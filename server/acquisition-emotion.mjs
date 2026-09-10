export const ACQUISITION_EMOTION_ENGINE_VERSION = "1.0.0";

const EMOTION_RULES = Object.freeze([
  {
    emotion:"frustration", intensity:"medium",
    pattern:/(?:不对|不准|答错|重复|还是不|怎么又|一直|没解决|失望|太机械|看不懂|乱答)/,
    support:"抱歉让您反复确认了，这次我会按您已经说清的方向继续。"
  },
  {
    emotion:"anxiety", intensity:"medium",
    pattern:/(?:担心|害怕|怕(?:不|会|疼|恢复|留)?|焦虑|风险大吗|会不会|不敢|顾虑)/,
    support:"您谨慎一点很正常，我先把能确认的信息说清楚。"
  },
  {
    emotion:"hesitation", intensity:"low",
    pattern:/(?:纠结|犹豫|拿不定|考虑一下|怎么选|选哪个|不知道选)/,
    support:"您把在意点说出来就很好，我们可以一项一项对比。"
  },
  {
    emotion:"self_conscious", intensity:"medium",
    pattern:/(?:自卑|没自信|不好看|很丑|困扰很久|不敢见人)/,
    support:"能理解这件事会让人介意，我们先从公开、可核验的信息开始了解。"
  },
  {
    emotion:"positive_expectation", intensity:"low",
    pattern:/(?:喜欢|期待|心动|想自然|想要自然|想精致|终于)/,
    support:"您对想要的感觉说得很清楚，这样更容易把信息讲准。"
  }
]);

const EMOTION_DISABLED_INTENTS = new Set([
  "medical_emergency", "medical_safety", "medical_suitability", "privacy_or_complaint",
  "human_handover_request", "security_or_compliance", "case_request_restricted"
]);

export function analyzeAcquisitionEmotion(message = "") {
  const text = String(message).trim();
  const matched = EMOTION_RULES.find((rule) => rule.pattern.test(text));
  return matched
    ? { emotion:matched.emotion, intensity:matched.intensity, matched:true, support:matched.support, version:ACQUISITION_EMOTION_ENGINE_VERSION }
    : { emotion:"neutral", intensity:"none", matched:false, support:"", version:ACQUISITION_EMOTION_ENGINE_VERSION };
}

/**
 * 情绪支持只补一句与当前表达相关的回应；不评价外貌、不承诺效果，也不在
 * 风险、投诉或人工接管场景中抢占人工沟通。
 */
export function enrichAcquisitionResponseWithEmotion({ message = "", intent = "", status = "completed", emotion } = {}) {
  const analysis = emotion || analyzeAcquisitionEmotion("");
  if (
    status !== "completed"
    || !analysis.matched
    || EMOTION_DISABLED_INTENTS.has(String(intent))
    || !String(message).trim()
  ) return { message:String(message).trim(), applied:false, analysis };
  if (String(message).includes(analysis.support)) return { message:String(message).trim(), applied:false, analysis };
  return {
    message:`${analysis.support}\n${String(message).trim()}`,
    applied:true,
    analysis
  };
}

export function getAcquisitionEmotionStatus() {
  return {
    version:ACQUISITION_EMOTION_ENGINE_VERSION,
    supported_emotions:EMOTION_RULES.map((item) => item.emotion),
    safety_boundary:"不评价外貌、不做医疗判断、不在风险或投诉场景中自动安抚"
  };
}
