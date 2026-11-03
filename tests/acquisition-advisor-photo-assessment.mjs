import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assessPhotoPixels,
  PHOTO_ASSESSMENT_DISCLAIMER,
  PHOTO_ASSESSMENT_METHOD_VERSION
} from "../apps/acquisition-advisor/src/photo-assessment.js";
import {
  buildSelfAssessmentQuestion,
  SELF_ASSESSMENT_AREAS,
  SELF_ASSESSMENT_DISCLOSURE
} from "../apps/acquisition-advisor/src/photo-self-assessment.js";

const imageData = (width, height, pixelAt) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = pixelAt(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
};

const width = 96;
const height = 128;
const flat = assessPhotoPixels({
  data:imageData(width, height, () => 150),
  width,
  height,
  sourceWidth:640,
  sourceHeight:853
});
const detailed = assessPhotoPixels({
  data:imageData(width, height, (x, y) => (x + y) % 2 ? 48 : 218),
  width,
  height,
  sourceWidth:1200,
  sourceHeight:1600
});
const lowResolution = assessPhotoPixels({
  data:imageData(width, height, (x, y) => (x + y) % 2 ? 48 : 218),
  width,
  height,
  sourceWidth:220,
  sourceHeight:293
});

assert.equal(flat.available, true);
assert.equal(flat.method, PHOTO_ASSESSMENT_METHOD_VERSION);
assert.ok(detailed.score > flat.score, "有清晰纹理和足够尺寸的图片应获得更高分");
assert.ok(detailed.dimensions.clarity > flat.dimensions.clarity, "清晰度应区分平色与细节图像");
assert.ok(detailed.score > lowResolution.score, "高分辨率应提高照片自检分");
assert.ok(detailed.suggestions.length >= 1 && detailed.suggestions.length <= 3);
assert.ok(Number.isFinite(detailed.dimensions.exposure));
assert.ok(Number.isFinite(detailed.dimensions.contrast));
assert.ok(Number.isFinite(detailed.measurements.average_edge));
assert.match(detailed.disclaimer, /不判断外貌、皮肤问题或项目适用性/);
assert.doesNotMatch(JSON.stringify(detailed), /颜值|吸引力|魅力|诊断结论/);

const unavailable = assessPhotoPixels({ data:new Uint8ClampedArray(0), width:0, height:0 });
assert.equal(unavailable.available, false);
assert.match(unavailable.message, /无法读取/);

const appSource = await readFile(new URL("../apps/acquisition-advisor/src/App.jsx", import.meta.url), "utf8");
const uploadSource = appSource.slice(
  appSource.indexOf("const submitUpload"),
  appSource.indexOf("const scoreSentPhotoAttachments")
);
const sendSource = appSource.slice(
  appSource.indexOf("const sendQuestion"),
  appSource.indexOf("const retryQuestion", appSource.indexOf("const sendQuestion"))
);
assert.ok(uploadSource, "必须能定位上传处理逻辑");
assert.ok(sendSource, "必须能定位消息发送逻辑");
assert.match(appSource, /const canSend = Boolean\(value\.trim\(\) \|\| pendingAttachments\.length\) && !disabled;/, "仅有待发送图片时发送按钮必须可用");
assert.match(appSource, /const hasImageAttachment = pendingAttachments\.some\(\(item\) => String\(item\.mime_type \|\| ""\)\.startsWith\("image\/"\)\)/, "必须识别纯图片附件");
assert.match(appSource, /hasImageAttachment\s*\? "发送了一张照片"/, "纯图片发送必须生成安全的默认消息文本");
assert.ok(appSource.includes("(!value.trim() && !pendingAttachments.length) || disabled"), "回车发送也必须允许纯图片消息");
assert.match(appSource, /const skipAiReply = !typedQuestion && hasImageAttachment/, "纯图片消息不得立即触发无关AI回复");
assert.match(appSource, /questionInFlightRef\.current = !skipAiReply/, "纯图片消息不得占用AI请求状态");
assert.match(appSource, /if \(skipAiReply\) return;/, "纯图片发送必须在AI请求前结束本地处理");
assert.doesNotMatch(uploadSource, /analyzePhotoFile/, "上传阶段不得提前评分");
assert.match(sendSource, /scoreSentPhotoAttachments\(messageKey, attachmentContexts\)/, "发送消息后才触发照片评分");
assert.match(sendSource, /photoAssessmentStatus:item\.photoAssessment\?\.available\s*\? "complete"\s*:\s*String\(item\.mime_type \|\| ""\)\.startsWith\("image\/"\) \? "scoring"/, "已发送图片在计算期间显示评分中状态");
assert.match(sendSource, /sourceFile:item\.sourceFile/, "发送后的本地评分必须保留待评分文件");
assert.doesNotMatch(appSource, /PhotoScoreDetails attachments=\{pendingAttachments\}/, "待发送区不得提前展示评分");
assert.match(appSource, /正在分析清晰度、曝光、明暗层次和有效分辨率/, "评分中状态必须明确说明发生在发送后");
assert.match(appSource, /role:"photo-report"/, "发送图片后必须追加独立的完整报告消息");
assert.match(appSource, /photoAssessmentStatus:"scoring"/, "报告消息必须先进入评分中状态");
assert.match(appSource, /你的照片质量指标/);
assert.match(appSource, /清晰度指数/);
assert.match(appSource, /平均曝光/);
assert.match(appSource, /明暗层次/);
assert.match(appSource, /有效分辨率/);
assert.match(appSource, /data-photo-report-id/);
assert.doesNotMatch(appSource, /PhotoScoreDetails/, "旧的小评分卡不得继续作为发送后结果");
assert.match(appSource, /photoAssessment:item\.photoAssessment/, "重试发送必须保留照片自检结果");
assert.match(appSource, /pendingSelfAssessmentRef\.current = question/, "当前回复未结束时自评必须排队而不是丢失");
assert.match(appSource, /onPhotoSelfAssessmentSubmit=\{submitPhotoSelfAssessment\}/, "报告必须接入个人关注自评提交");
assert.match(appSource, /我的个人关注自评|buildSelfAssessmentQuestion/, "自评必须以用户主动表达生成咨询上下文");
const reportSource = appSource.slice(
  appSource.indexOf("function PhotoAssessmentReport"),
  appSource.indexOf("function Composer")
);
assert.doesNotMatch(reportSource, /面部比例|颜值|吸引力|适合做|治疗效果/, "照片报告不得输出外貌比例或医疗适用性判断");

assert.match(PHOTO_ASSESSMENT_DISCLAIMER, /本地完成/);
assert.match(PHOTO_ASSESSMENT_DISCLAIMER, /不交给视觉模型/);

assert.deepEqual(
  SELF_ASSESSMENT_AREAS.map((area) => area.label),
  ["眼部", "耳部", "鼻部", "口唇", "轮廓与对称", "肤色与光暗"]
);
const selfAssessmentQuestion = buildSelfAssessmentQuestion(
  { eyes:4, nose:5, symmetry:3 },
  "更希望先了解一般区别"
);
assert.match(selfAssessmentQuestion, /这是我的个人关注自评/);
assert.match(selfAssessmentQuestion, /眼部：比较关注（4\/5）/);
assert.match(selfAssessmentQuestion, /鼻部：很关注（5\/5）/);
assert.match(selfAssessmentQuestion, /轮廓与对称：一般（3\/5）/);
assert.doesNotMatch(selfAssessmentQuestion, /耳部|口唇|肤色与光暗/);
assert.match(selfAssessmentQuestion, /补充说明：更希望先了解一般区别/);
assert.match(selfAssessmentQuestion, /是否适合及具体方案，请引导我到院面诊确认/);
assert.equal(buildSelfAssessmentQuestion({}, ""), "");
assert.match(SELF_ASSESSMENT_DISCLOSURE, /不是根据照片推断五官、对称、肤色或皮肤状态/);

console.log("acquisition-advisor-photo-assessment: passed");
