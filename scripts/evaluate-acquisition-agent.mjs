import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 评测不写入本地试运行会话和运营数据；真实上线环境的持久化配置也不参与本脚本。
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";

const { invokeAgent } = await import("../server/agent-runtime.mjs");
const { evaluateAcquisitionConversationCopy } = await import("../server/acquisition-conversation-style.mjs");
const {
  prepareAcquisitionSessionContext,
  recordAcquisitionSessionTurn,
  resetAcquisitionSessionsForTest
} = await import("../server/acquisition-session.mjs");
const { selectPublicKnowledgeMedia } = await import("../server/knowledge-media.mjs");
const { getHuameiKnowledgeStatus } = await import("../server/huamei-knowledge.mjs");

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultKnowledgeRoot = join(projectRoot, "..", "一期项目文件", "华美智能体知识库_v1");
const knowledgeRoot = process.env.HUAMEI_KNOWLEDGE_ROOT
  ? (isAbsolute(process.env.HUAMEI_KNOWLEDGE_ROOT)
    ? process.env.HUAMEI_KNOWLEDGE_ROOT
    : resolve(projectRoot, process.env.HUAMEI_KNOWLEDGE_ROOT))
  : defaultKnowledgeRoot;
const evalRoot = join(knowledgeRoot, "智能体评测集_v3_对话体验与知识路由");
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [argument, true];
}));
const mode = ["smoke", "coverage", "full"].includes(options.mode) ? options.mode : "coverage";
const requestedLimit = Math.max(0, Number(options.limit) || 0);
const outputPath = resolve(projectRoot, String(options.output || "artifacts/acquisition-eval-report.json"));
const INTERNAL_LANGUAGE = /知识库|资料库|检索(?:结果|记录|内容|命中)?|命中(?:结果|记录|内容)?|本地规则草稿|系统上下文|提示词|内部实现/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonLines = (path) => readFileSync(path, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ratio = (value, total) => total ? Number((value / total).toFixed(4)) : 0;
const take = (rows, smokeLimit) => rows.slice(0, requestedLimit || (mode === "smoke" ? smokeLimit : rows.length));
const unique = (items) => [...new Set(items.filter(Boolean))];
const safeContext = (extra = {}) => ({
  macro_stage:"售前",
  micro_stage:"评测",
  service_consent:true,
  marketing_consent:false,
  owner:"评测人工队列",
  interests:[],
  ...extra
});
const assertion = (passed, code, expected, actual) => ({ passed:Boolean(passed), code, expected, actual });

function assessTurn(testCase, context = {}) {
  const expected = testCase.expected || {};
  const result = invokeAgent("A-01", {
    message:testCase.user_message,
    mode:"reply",
    channel:"evaluation",
    context:safeContext(context)
  }, { caller:"acquisition_evaluation_v3" });
  const output = result.output || {};
  const message = String(output.message || "");
  const data = output.structured_data || {};
  const citations = Array.isArray(output.citations) ? output.citations : [];
  const media = selectPublicKnowledgeMedia({
    message:testCase.user_message,
    citations,
    intent:data.intent || ""
  });
  const emotion = data.emotion || {};
  const route = data.answer_routing?.route || "";
  const retrievalStrategy = data.answer_routing?.retrieval_strategy || "";
  const checks = [];
  const check = (passed, code, expectedValue, actualValue) => checks.push(assertion(passed, code, expectedValue, actualValue));

  if (expected.intent) check(data.intent === expected.intent, "intent", expected.intent, data.intent);
  if (expected.status) check(result.status === expected.status, "status", expected.status, result.status);
  if (expected.answer_route) check(route === expected.answer_route, "answer_route", expected.answer_route, route);
  if (expected.retrieval_strategy) check(retrievalStrategy === expected.retrieval_strategy, "retrieval_strategy", expected.retrieval_strategy, retrievalStrategy);
  if (expected.emotion) check(emotion.emotion === expected.emotion, "emotion", expected.emotion, emotion.emotion);
  if (typeof expected.emotion_support_applied === "boolean") {
    check(emotion.support_applied === expected.emotion_support_applied, "emotion_support_applied", expected.emotion_support_applied, emotion.support_applied);
  }
  for (const phrase of expected.reply_contains || []) check(message.includes(phrase), "reply_contains", phrase, message);
  if (expected.reply_contains_any?.length) {
    check(expected.reply_contains_any.some((phrase) => message.includes(phrase)), "reply_contains_any", expected.reply_contains_any, message);
  }
  for (const phrase of expected.must_not_include || []) check(!message.includes(phrase), "must_not_include", phrase, message);
  for (const prefix of expected.must_not_prefix || []) check(!message.trim().startsWith(prefix), "must_not_prefix", prefix, message.trim());
  if (Number.isFinite(expected.citations_min)) check(citations.length >= expected.citations_min, "citations_min", expected.citations_min, citations.length);
  if (Number.isFinite(expected.media_min)) check(media.length >= expected.media_min, "media_min", expected.media_min, media.length);
  if (Number.isFinite(expected.media_max)) check(media.length <= expected.media_max, "media_max", expected.media_max, media.length);
  if (expected.media_path_prefix) {
    check(media.some((item) => String(item.source_relative_path || "").startsWith(expected.media_path_prefix)), "media_path_prefix", expected.media_path_prefix, media.map((item) => item.source_relative_path));
  }
  if (expected.media_path_contains) {
    check(media.some((item) => String(item.source_relative_path || "").includes(expected.media_path_contains)), "media_path_contains", expected.media_path_contains, media.map((item) => item.source_relative_path));
  }
  // 拒绝提示词/密钥索取时可说明“不能披露”，这不是泄露；其余对客答复
  // 禁止出现内部实现语言。
  if (data.intent !== "security_or_compliance") {
    check(!INTERNAL_LANGUAGE.test(message), "no_internal_language", "无内部实现语言", message);
  }

  const style = evaluateAcquisitionConversationCopy(message, { intent:data.intent, context });
  if (result.status === "completed") check(style.valid, "conversation_style", "短句、单一追问、无机器人话术", style.reason_codes);
  return {
    case_id:testCase.case_id,
    category:testCase.category || testCase.scenario || "multi_turn",
    user_message:testCase.user_message,
    passed:checks.every((item) => item.passed),
    checks,
    actual:{
      intent:data.intent || "",
      status:result.status,
      answer_route:route,
      retrieval_strategy:retrievalStrategy,
      emotion:emotion.emotion || "",
      emotion_support_applied:Boolean(emotion.support_applied),
      citations:citations.length,
      media:media.map((item) => item.source_relative_path),
      style_reason_codes:style.reason_codes,
      reply:message
    },
    result
  };
}

const rubricPath = join(evalRoot, "scoring_rubric.json");
const singlePath = join(evalRoot, "single_turn_cases.jsonl");
const multiPath = join(evalRoot, "multi_turn_dialogues.jsonl");
const rubric = readJson(rubricPath);
const singleCases = take(readJsonLines(singlePath), 12);
const multiDialogues = take(readJsonLines(multiPath), 2);
const singleResults = singleCases.map((testCase) => assessTurn(testCase, testCase.context || {}));

resetAcquisitionSessionsForTest();
const multiResults = [];
for (const dialogue of multiDialogues) {
  const sessionId = `eval-v3-${dialogue.dialogue_id}`;
  const turns = [];
  for (const [index, turn] of (dialogue.turns || []).entries()) {
    const sessionContext = prepareAcquisitionSessionContext(sessionId, turn.user_message, []);
    const evaluated = assessTurn({
      ...turn,
      case_id:`${dialogue.dialogue_id}-${index + 1}`,
      category:dialogue.scenario
    }, sessionContext);
    const projects = unique([
      evaluated.actual.intent === "doctor_discovery_by_project" ? "胸部整形" : "",
      evaluated.result.output?.structured_data?.project,
      ...(evaluated.result.output?.structured_data?.projects || [])
    ]);
    recordAcquisitionSessionTurn(sessionId, { message:turn.user_message, result:evaluated.result, projects });
    turns.push(evaluated);
  }
  multiResults.push({
    dialogue_id:dialogue.dialogue_id,
    scenario:dialogue.scenario,
    passed:turns.every((turn) => turn.passed),
    turns
  });
}

const flattenedMulti = multiResults.flatMap((dialogue) => dialogue.turns);
const allResults = [...singleResults, ...flattenedMulti];
const failures = allResults.filter((item) => !item.passed).map((item) => ({
  case_id:item.case_id,
  category:item.category,
  failed_checks:item.checks.filter((check) => !check.passed),
  actual:item.actual
}));
const enterprise = allResults.filter((item) => item.checks.some((check) => check.code === "answer_route" && check.expected === "enterprise_knowledge_graph"));
const risk = allResults.filter((item) => ["handover_required", "blocked"].includes(item.checks.find((check) => check.code === "status")?.expected));
const restrictedMediaLeakCount = allResults.filter((item) => item.checks.some((check) => check.code === "media_max" && check.expected === 0) && item.actual.media.length > 0).length;
const internalLanguageLeakCount = allResults.filter((item) => item.actual.intent !== "security_or_compliance" && INTERNAL_LANGUAGE.test(item.actual.reply)).length;
const graphDefaultViolationCount = allResults.filter((item) => item.checks.some((check) => check.code === "retrieval_strategy" && check.expected !== "graph_rag") && item.actual.retrieval_strategy === "graph_rag").length;
const enterpriseRouteAccuracy = ratio(enterprise.filter((item) => item.actual.answer_route === "enterprise_knowledge_graph").length, enterprise.length);
const riskHandlingRecall = ratio(risk.filter((item) => ["handover_required", "blocked"].includes(item.actual.status)).length, risk.length);
const singlePassRate = ratio(singleResults.filter((item) => item.passed).length, singleResults.length);
const multiPassRate = ratio(multiResults.filter((item) => item.passed).length, multiResults.length);
const gates = {
  single_turn_pass_rate:{ target:rubric.release_gates.single_turn_pass_rate, actual:singlePassRate, passed:singlePassRate >= rubric.release_gates.single_turn_pass_rate },
  multi_turn_pass_rate:{ target:rubric.release_gates.multi_turn_pass_rate, actual:multiPassRate, passed:multiPassRate >= rubric.release_gates.multi_turn_pass_rate },
  enterprise_route_accuracy:{ target:rubric.release_gates.enterprise_route_accuracy, actual:enterpriseRouteAccuracy, passed:enterpriseRouteAccuracy >= rubric.release_gates.enterprise_route_accuracy },
  restricted_media_leak_count:{ target:0, actual:restrictedMediaLeakCount, passed:restrictedMediaLeakCount === 0 },
  risk_handling_recall:{ target:rubric.release_gates.risk_handling_recall, actual:riskHandlingRecall, passed:riskHandlingRecall >= rubric.release_gates.risk_handling_recall },
  internal_language_leak_count:{ target:0, actual:internalLanguageLeakCount, passed:internalLanguageLeakCount === 0 },
  graph_default_violation_count:{ target:0, actual:graphDefaultViolationCount, passed:graphDefaultViolationCount === 0 }
};
const report = {
  report_version:"4.0",
  evidence_class:rubric.evidence_class,
  generated_at:new Date().toISOString(),
  mode,
  knowledge:getHuameiKnowledgeStatus(),
  evaluation_contract:{
    dataset:"智能体评测集_v3_对话体验与知识路由",
    dimensions:rubric.dimensions,
    manual_blind_review:rubric.manual_blind_review,
    note:"自动回归验证确定性运行时的行为断言。真实模型回答、医疗广告素材和院方事实仍须业务、医务与合规盲评。"
  },
  dataset_integrity:{
    scoring_rubric_sha256:sha256File(rubricPath),
    single_turn_cases_sha256:sha256File(singlePath),
    multi_turn_dialogues_sha256:sha256File(multiPath),
    selected_single_cases:singleCases.length,
    selected_multi_dialogues:multiDialogues.length
  },
  summary:{
    single_cases:singleResults.length,
    single_passed:singleResults.filter((item) => item.passed).length,
    multi_dialogues:multiResults.length,
    multi_passed:multiResults.filter((item) => item.passed).length,
    multi_turns:flattenedMulti.length,
    assertions:allResults.reduce((sum, item) => sum + item.checks.length, 0),
    failed_cases:failures.length
  },
  gates,
  passed:Object.values(gates).every((gate) => gate.passed),
  failures:failures.slice(0, 100),
  results:{
    single_turn:singleResults.map(({ result, ...item }) => item),
    multi_turn:multiResults.map((dialogue) => ({
      ...dialogue,
      turns:dialogue.turns.map(({ result, ...item }) => item)
    }))
  }
};
mkdirSync(dirname(outputPath), { recursive:true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output:outputPath, passed:report.passed, summary:report.summary, gates, failures:report.failures }, null, 2));
if (!report.passed) process.exitCode = 1;
