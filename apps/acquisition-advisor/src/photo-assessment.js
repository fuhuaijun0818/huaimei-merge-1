const SAMPLE_EDGE = 192;

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const PHOTO_ASSESSMENT_METHOD_VERSION = "local-photo-quality-v1";
export const PHOTO_ASSESSMENT_DISCLAIMER = "仅评估照片清晰度、光线和分辨率，不判断外貌、皮肤问题或项目适用性。评分在当前浏览器本地完成，不交给视觉模型。";

const scoreLabel = (score) => {
  if (score >= 85) return "清晰可用";
  if (score >= 70) return "基本可用";
  if (score >= 55) return "建议优化";
  return "建议重拍";
};

const scoreTone = (score) => {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 55) return "fair";
  return "low";
};

const resolutionScore = (sourceWidth, sourceHeight) => {
  const shortEdge = Math.min(Number(sourceWidth) || 0, Number(sourceHeight) || 0);
  if (shortEdge >= 1200) return 100;
  if (shortEdge >= 900) return 92;
  if (shortEdge >= 640) return 80;
  if (shortEdge >= 480) return 68;
  if (shortEdge >= 320) return 52;
  if (shortEdge >= 200) return 38;
  return 22;
};

export function assessPhotoPixels({
  data,
  width,
  height,
  sourceWidth = width,
  sourceHeight = height
} = {}) {
  const pixelWidth = Math.max(0, Math.floor(Number(width) || 0));
  const pixelHeight = Math.max(0, Math.floor(Number(height) || 0));
  if (!data || pixelWidth < 2 || pixelHeight < 2 || data.length < pixelWidth * pixelHeight * 4) {
    return {
      available:false,
      method:PHOTO_ASSESSMENT_METHOD_VERSION,
      message:"无法读取这张图片的像素信息"
    };
  }

  const luminance = new Float32Array(pixelWidth * pixelHeight);
  let luminanceTotal = 0;
  let clipped = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const value = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    luminance[index] = value;
    luminanceTotal += value;
    if (value < 10 || value > 245) clipped += 1;
  }

  const mean = luminanceTotal / luminance.length;
  let varianceTotal = 0;
  for (const value of luminance) varianceTotal += (value - mean) ** 2;
  const standardDeviation = Math.sqrt(varianceTotal / luminance.length);

  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = 1; y < pixelHeight; y += 1) {
    for (let x = 1; x < pixelWidth; x += 1) {
      const index = y * pixelWidth + x;
      edgeTotal += Math.abs(luminance[index] - luminance[index - 1])
        + Math.abs(luminance[index] - luminance[index - pixelWidth]);
      edgeCount += 1;
    }
  }
  const averageEdge = edgeCount ? edgeTotal / edgeCount : 0;
  const clippedRatio = clipped / luminance.length;

  const clarityScore = clampScore((averageEdge - 1.2) * 7.2);
  const brightnessScore = clampScore(100 - Math.abs(mean - 148) * 1.05 - clippedRatio * 80);
  const contrastScore = clampScore(100 - Math.abs(standardDeviation - 52) * 1.35);
  const lightingScore = clampScore(brightnessScore * 0.65 + contrastScore * 0.35);
  const dimensionsScore = resolutionScore(sourceWidth, sourceHeight);
  const score = clampScore(
    clarityScore * 0.42
    + lightingScore * 0.30
    + dimensionsScore * 0.28
  );

  const suggestions = [];
  if (clarityScore < 68) suggestions.push("镜头可能未对焦或画面有抖动，建议保持稳定并重新对焦");
  if (brightnessScore < 62) suggestions.push("光线偏暗或曝光过度，建议面向柔和自然光，避免背光");
  else if (contrastScore < 58) suggestions.push("明暗层次较弱，建议避免滤镜和过度磨皮后重拍");
  if (dimensionsScore < 66) suggestions.push("图片分辨率偏低，建议上传未压缩的原始照片");
  if (!suggestions.length) suggestions.push("照片质量良好，可以随咨询问题一起发送");

  return {
    available:true,
    method:PHOTO_ASSESSMENT_METHOD_VERSION,
    score,
    label:scoreLabel(score),
    tone:scoreTone(score),
    dimensions:{
      clarity:clarityScore,
      lighting:lightingScore,
      resolution:dimensionsScore
    },
    source:{
      width:Math.max(0, Math.round(Number(sourceWidth) || 0)),
      height:Math.max(0, Math.round(Number(sourceHeight) || 0))
    },
    suggestions:suggestions.slice(0, 3),
    disclaimer:PHOTO_ASSESSMENT_DISCLAIMER
  };
}

export async function analyzePhotoFile(file, options = {}) {
  if (!file || !String(file.type || "").toLowerCase().startsWith("image/")) return null;
  const createBitmap = options.createImageBitmap || globalThis.createImageBitmap;
  const documentRef = options.document || globalThis.document;
  if (typeof createBitmap !== "function" || !documentRef?.createElement) {
    throw new Error("当前浏览器不支持本地照片自检");
  }

  let bitmap;
  try {
    bitmap = await createBitmap.call(globalThis, file, { imageOrientation:"from-image" });
  } catch {
    bitmap = await createBitmap.call(globalThis, file);
  }
  try {
    const sourceWidth = Number(bitmap.width) || Number(file.imageWidth) || 0;
    const sourceHeight = Number(bitmap.height) || Number(file.imageHeight) || 0;
    if (!sourceWidth || !sourceHeight) throw new Error("无法读取照片尺寸");
    const scale = Math.min(1, SAMPLE_EDGE / Math.max(sourceWidth, sourceHeight));
    const sampleWidth = Math.max(2, Math.round(sourceWidth * scale));
    const sampleHeight = Math.max(2, Math.round(sourceHeight * scale));
    const canvas = documentRef.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext("2d", { willReadFrequently:true });
    if (!context) throw new Error("无法创建照片分析画布");
    context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
    const imageData = context.getImageData(0, 0, sampleWidth, sampleHeight);
    return {
      ...assessPhotoPixels({
        data:imageData.data,
        width:sampleWidth,
        height:sampleHeight,
        sourceWidth,
        sourceHeight
      }),
      sampled_pixels:`${sampleWidth}x${sampleHeight}`,
      sampling_coverage:clamp01((sampleWidth * sampleHeight) / (sourceWidth * sourceHeight))
    };
  } finally {
    bitmap?.close?.();
  }
}
