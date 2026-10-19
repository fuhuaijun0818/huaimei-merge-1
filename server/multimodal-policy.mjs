const zhPattern = /[\u3400-\u9fff]/g;
const latinPattern = /[A-Za-z]/g;

export const classifyLanguage = (value = "") => {
  const text = String(value || "");
  const zh = (text.match(zhPattern) || []).length;
  const latin = (text.match(latinPattern) || []).length;
  if (zh && latin && latin > zh * 0.3) return "mixed";
  if (latin > zh) return "en";
  if (zh) return "zh";
  return "other";
};

const countBy = (items, keyOf) => items.reduce((result, item) => {
  const key = keyOf(item);
  result[key] = (result[key] || 0) + 1;
  return result;
}, {});

export const getMultimodalReadiness = ({ records = [], queries = [], env = process.env } = {}) => {
  const language = countBy(records, (record) => classifyLanguage(record.content || record.text || ""));
  const queryLanguage = countBy(queries, (query) => classifyLanguage(typeof query === "string" ? query : query.query));
  const recordTypes = countBy(records, (record) => String(record.record_type || "unknown"));
  const ocrRecords = records.filter((record) => record.record_type === "image_ocr");
  const ocrMissingVerification = ocrRecords.filter((record) => !String(record.verification_note || "").trim()).length;
  const multilingualRequested = String(env.HUAMEI_MULTILINGUAL_RETRIEVAL_ENABLED || "false").toLowerCase() === "true";
  const imageRequested = String(env.HUAMEI_IMAGE_RETRIEVAL_ENABLED || "false").toLowerCase() === "true";
  const multilingualApproved = String(env.HUAMEI_MULTILINGUAL_EMBEDDING_APPROVED || "false").toLowerCase() === "true";
  const imageApproved = String(env.HUAMEI_IMAGE_EMBEDDING_APPROVED || "false").toLowerCase() === "true";
  const blockedReasons = [];
  if (multilingualRequested && !multilingualApproved) blockedReasons.push("MULTILINGUAL_EMBEDDING_NOT_APPROVED");
  if (imageRequested && !imageApproved) blockedReasons.push("IMAGE_EMBEDDING_NOT_APPROVED");
  if (imageRequested) blockedReasons.push("IMAGE_RETRIEVAL_REQUIRES_RECORD_ID_MAPPING_AND_HUMAN_REVIEW");
  return {
    language,
    query_language:queryLanguage,
    record_types:recordTypes,
    ocr_records:ocrRecords.length,
    ocr_missing_verification:ocrMissingVerification,
    flags:{
      multilingual_requested:multilingualRequested,
      multilingual_approved:multilingualApproved,
      image_requested:imageRequested,
      image_approved:imageApproved
    },
    blocked_reasons:[...new Set(blockedReasons)]
  };
};

export const assertMultimodalRuntimeSafe = (options = {}) => {
  const status = getMultimodalReadiness(options);
  if (status.blocked_reasons.length) {
    const error = new Error("多语言或图片检索未满足发布前置条件");
    error.code = status.blocked_reasons[0];
    error.details = status.blocked_reasons;
    throw error;
  }
  return status;
};

export const getMultimodalGuardrail = (env = process.env) => ({
  ocr_text_only:true,
  image_embedding:false,
  generated_image_description_as_fact:false,
  multilingual_retrieval:false,
  image_retrieval:false,
  flags:{
    multilingual_requested:String(env.HUAMEI_MULTILINGUAL_RETRIEVAL_ENABLED || "false").toLowerCase() === "true",
    image_requested:String(env.HUAMEI_IMAGE_RETRIEVAL_ENABLED || "false").toLowerCase() === "true"
  }
});
