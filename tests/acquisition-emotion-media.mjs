import assert from "node:assert/strict";
import { analyzeAcquisitionEmotion, enrichAcquisitionResponseWithEmotion } from "../server/acquisition-emotion.mjs";
import { routeAcquisitionAnswer } from "../server/acquisition-answer-routing.mjs";
import { invokeAgent } from "../server/agent-runtime.mjs";
import { previewPublicKnowledgeMediaForSource, publicKnowledgeMediaTypeForPath, resolvePublicKnowledgeMedia, selectPublicKnowledgeMedia } from "../server/knowledge-media.mjs";

const concern = analyzeAcquisitionEmotion("我有点担心恢复会不会很久");
assert.equal(concern.emotion, "anxiety");
const supportive = enrichAcquisitionResponseWithEmotion({
  message:"一般恢复安排需要结合面诊后确认。",
  intent:"project_explanation",
  status:"completed",
  emotion:concern
});
assert.equal(supportive.applied, true);
assert.match(supportive.message, /谨慎一点很正常/);
assert.equal(enrichAcquisitionResponseWithEmotion({ message:"请立即联系人工团队。", intent:"medical_safety", status:"handover_required", emotion:concern }).applied, false);

const genericRoute = routeAcquisitionAnswer({
  message:"假体隆胸和自体脂肪隆胸一般有什么区别？",
  intent:"project_comparison",
  analysis:{ entities:{ projects:["胸部整形"] } }
});
assert.equal(genericRoute.route, "enterprise_knowledge_graph");
assert.equal(genericRoute.retrieval_strategy, "graph_rag");
assert.equal(genericRoute.model_generation_mode, "grounded_copy_only");
const enterpriseRoute = routeAcquisitionAnswer({
  message:"李健院长这周有排班吗？",
  intent:"doctor_schedule_verification",
  analysis:{ entities:{ doctors:["李健"] } }
});
assert.equal(enterpriseRoute.route, "enterprise_knowledge_graph");

const doctor = invokeAgent("A-01", {
  message:"发一下李健院长丰胸宣传海报",
  mode:"reply",
  context:{ tenant_id:"huamei-shanghai" }
});
const media = selectPublicKnowledgeMedia({
  message:"发一下李健院长丰胸宣传海报",
  citations:doctor.output.citations,
  intent:doctor.output.structured_data.intent
});
assert.ok(media.length > 0, "医生公开宣传资料应可随回复返回");
assert.ok(media.every((item) => item.source_relative_path.startsWith("医生介绍/")));
assert.ok(media.some((item) => /丰胸|隆胸/.test(item.source_relative_path)), "图片必须与客户指定项目方向匹配");
const resolved = resolvePublicKnowledgeMedia(media[0].id);
assert.ok(resolved?.path);
assert.match(resolved.mime, /^image\//);
assert.equal(resolvePublicKnowledgeMedia("asset_0000000000000000"), null);
const preview = previewPublicKnowledgeMediaForSource(media[0].source_relative_path);
assert.equal(preview?.id, media[0].id, "引用资料应只能通过公开素材清单生成预览入口");
assert.equal(preview?.type, "image");
assert.match(preview?.url || "", /^\/api\/public\/knowledge-media\/asset_/);
assert.equal(previewPublicKnowledgeMediaForSource("聊天记录/client0/0.png"), null, "聊天记录不得通过引用获得前台预览");
assert.equal(publicKnowledgeMediaTypeForPath("项目介绍/公开资料.pdf"), "pdf", "后续审核发布的公开 PDF 应使用内嵌预览类型");

const mask = invokeAgent("A-01", {
  message:"面膜",
  mode:"reply",
  context:{ tenant_id:"huamei-shanghai" }
});
assert.equal(mask.output.structured_data.intent, "product_catalog_detail");
const maskMedia = selectPublicKnowledgeMedia({
  message:"面膜",
  citations:mask.output.citations,
  intent:mask.output.structured_data.intent
});
assert.ok(maskMedia.some((item) => /明星产品.*面膜/.test(item.source_relative_path)), "明确产品名称时应自动带回已审核产品图片");

console.log("✓ 情绪识别、通用科普/院方事实路由与公开资料预览白名单通过");
