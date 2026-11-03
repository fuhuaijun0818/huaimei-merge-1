import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assessPhotoPixels,
  PHOTO_ASSESSMENT_DISCLAIMER,
  PHOTO_ASSESSMENT_METHOD_VERSION
} from "../apps/acquisition-advisor/src/photo-assessment.js";

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
assert.match(detailed.disclaimer, /不判断外貌、皮肤问题或项目适用性/);
assert.doesNotMatch(JSON.stringify(detailed), /颜值|吸引力|魅力|诊断结论/);

const unavailable = assessPhotoPixels({ data:new Uint8ClampedArray(0), width:0, height:0 });
assert.equal(unavailable.available, false);
assert.match(unavailable.message, /无法读取/);

const appSource = await readFile(new URL("../apps/acquisition-advisor/src/App.jsx", import.meta.url), "utf8");
assert.match(appSource, /analyzePhotoFile\(file\)/, "上传图片后必须在本地触发照片自检");
assert.match(appSource, /照片自检/);
assert.match(appSource, /photoAssessment:item\.photoAssessment/, "重试发送必须保留照片自检结果");
assert.match(appSource, /PhotoScoreDetails attachments=\{pendingAttachments\}/, "待发送区必须展示自检结果");
assert.match(appSource, /PhotoScoreDetails attachments=\{message\.attachments/, "已发送消息必须保留自检结果");

assert.match(PHOTO_ASSESSMENT_DISCLAIMER, /本地完成/);
assert.match(PHOTO_ASSESSMENT_DISCLAIMER, /不交给视觉模型/);

console.log("acquisition-advisor-photo-assessment: passed");
