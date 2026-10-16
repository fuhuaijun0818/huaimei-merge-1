import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_KNOWLEDGE_MEDIA_VERSION = "1.1.0";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const knowledgeRoot = String(process.env.HUAMEI_KNOWLEDGE_ROOT || "").trim()
  || join(projectRoot, "..", "一期项目文件", "华美智能体知识库_v1");
const rawDataRoot = String(process.env.HUAMEI_RAW_DATA_ROOT || "").trim()
  || join(projectRoot, "..", "一期项目文件", "原始数据");
const manifestPath = join(knowledgeRoot, "assets.jsonl");
const configuredPublicMaterialsRoot = String(process.env.HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT || "").trim();
const publicMaterialsRoot = configuredPublicMaterialsRoot
  ? resolve(projectRoot, configuredPublicMaterialsRoot)
  : join(knowledgeRoot, "public-materials-v1");
const publicMaterialsManifestPath = join(publicMaterialsRoot, "assets.jsonl");
const PUBLIC_MEDIA_EXTENSIONS = new Map([
  [".jpg", { mime:"image/jpeg", type:"image" }],
  [".jpeg", { mime:"image/jpeg", type:"image" }],
  [".png", { mime:"image/png", type:"image" }],
  [".webp", { mime:"image/webp", type:"image" }],
  [".pdf", { mime:"application/pdf", type:"pdf" }]
]);
const PUBLIC_PREFIX = /^(?:医生介绍|项目介绍)\//;
const RESTRICTED_PATH = /(?:前后对比|聊天记录|客户画像|案例库|术前术后|病历|顾客|客户|私人|内部)/i;
const MEDIA_REQUEST = /(?:海报|宣传图|项目图|图片|照片|图看看|看图|发(?:一下|我|个)?(?:图|图片|海报|介绍)|pdf|PDF|文件|资料|电子版|文档)/;
// A customer who identifies a concrete retail product (for example “面膜”)
// expects the product card directly; a broad catalogue question still only
// receives text unless they ask for images.
const AUTO_MEDIA_INTENTS = new Set(["doctor_profile", "product_catalog_detail"]);
// 原始资料里存在少量长图海报。交付环境应接入对象存储的缩略图/转码，
// 本地可交付版先允许受控长图直出，仍绝不放开目录或路径读取。
const MAX_PUBLIC_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_PDF_BYTES = 32 * 1024 * 1024;
let assetCache = null;
let assetSourceCache = null;

const titleFor = (asset) => String(asset.content_label || asset.file_name || "公开宣传资料")
  .replace(/\.[a-z0-9]+$/i, "")
  .replace(/[【】]/g, "")
  .slice(0, 80);

const projectTermsFromMessage = (message = "") => {
  const text = String(message);
  return [
    ...(text.includes("特贝茨") ? ["特贝茨"] : []),
    ...(text.includes("曼托") ? ["曼托"] : []),
    ...(text.includes("傲诺拉") ? ["傲诺拉"] : []),
    ...(text.includes("璀璨") ? ["璀璨"] : []),
    ...(text.includes("丰胸") || text.includes("隆胸") ? ["丰胸", "隆胸"] : []),
    ...(text.includes("双眼皮") ? ["双眼皮"] : []),
    ...(text.includes("热玛吉") ? ["热玛吉"] : []),
    ...(text.includes("光子") ? ["光子"] : []),
    ...(text.includes("水光") ? ["水光"] : [])
  ];
};

const loadAssets = () => {
  if (assetCache) return assetCache;
  const assets = new Map();
  const sources = new Map();
  for (const candidateManifestPath of [manifestPath, publicMaterialsManifestPath]) {
    if (!existsSync(candidateManifestPath)) continue;
    for (const line of readFileSync(candidateManifestPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const asset = JSON.parse(line);
        if (asset?.asset_id && !assets.has(asset.asset_id)) {
          assets.set(asset.asset_id, asset);
          const sourcePath = String(asset.source_relative_path || "").trim();
          if (sourcePath && !sources.has(sourcePath)) sources.set(sourcePath, asset);
          // Link legacy citations that were indexed before the raw-data
          // \"公开资料\" folder prefix was retained in source paths.
          if (sourcePath.startsWith("公开资料/")) {
            const legacySourcePath = sourcePath.slice("公开资料/".length);
            // The reviewed public-materials package is the canonical media
            // location for legacy citations, so it deliberately replaces the
            // metadata-only asset entry from the older catalog.
            if (legacySourcePath) sources.set(legacySourcePath, asset);
          }
        }
      } catch {}
    }
  }
  assetCache = assets;
  assetSourceCache = sources;
  return assets;
};

const publicMediaDescriptorForPath = (sourcePath = "") => PUBLIC_MEDIA_EXTENSIONS.get(extname(String(sourcePath)).toLowerCase()) || null;
const maxBytesForDescriptor = (descriptor) => descriptor?.type === "pdf" ? MAX_PUBLIC_PDF_BYTES : MAX_PUBLIC_IMAGE_BYTES;
const isInsideRawDataRoot = (path) => {
  const relativePath = relative(rawDataRoot, path);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`);
};
const publicMaterialsDirectoryNames = () => {
  try {
    return readdirSync(rawDataRoot, { withFileTypes:true })
      .filter((entry) => entry.isDirectory() && /^公开资料(?:\d{2,8})?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "zh-CN"));
  } catch {
    return [];
  }
};
// Legacy v1 citations omit the raw-data folder's \"公开资料\" prefix. New
// records retain it. Resolve both forms without exposing arbitrary paths.
const localPathForAsset = (asset) => {
  const sourcePath = String(asset?.source_relative_path || "");
  const directPath = resolve(rawDataRoot, sourcePath);
  if (isInsideRawDataRoot(directPath) && existsSync(directPath)) return directPath;
  const publicRelativePath = sourcePath.startsWith("公开资料/")
    ? sourcePath.slice("公开资料/".length)
    : PUBLIC_PREFIX.test(sourcePath) ? sourcePath : "";
  if (publicRelativePath) {
    for (const directoryName of publicMaterialsDirectoryNames()) {
      const candidate = resolve(rawDataRoot, directoryName, publicRelativePath);
      if (isInsideRawDataRoot(candidate) && existsSync(candidate)) return candidate;
    }
  }
  return null;
};

export const publicKnowledgeMediaTypeForPath = (sourcePath = "") => publicMediaDescriptorForPath(sourcePath)?.type || null;

// 失败原因用于对客提示：只有本来就有资格公开的对象才区分“已过期/已撤回”，
// 受限或未审核对象一律按不存在处理，避免泄露内部资料是否存在。
const publicDeliveryVerdict = (asset) => {
  const sourcePath = String(asset?.source_relative_path || "");
  const descriptor = publicMediaDescriptorForPath(sourcePath);
  if (!asset || !descriptor) return { eligible:false, reason:"not_found" };
  const reviewedPublicMaterial = sourcePath.startsWith("公开资料/")
    && asset.review_status === "approved"
    && asset.reviewed_source === true
    && asset.default_agent_action === "public_media_candidate";
  if ((!PUBLIC_PREFIX.test(sourcePath) && !reviewedPublicMaterial) || RESTRICTED_PATH.test(sourcePath)) return { eligible:false, reason:"not_found" };
  if (Number(asset.size_bytes || 0) > maxBytesForDescriptor(descriptor)) return { eligible:false, reason:"not_found" };
  if (asset.withdrawn_at && Date.parse(asset.withdrawn_at) <= Date.now()) return { eligible:false, reason:"withdrawn" };
  if (asset.expires_at && Date.parse(asset.expires_at) <= Date.now()) return { eligible:false, reason:"expired" };
  if (!localPathForAsset(asset)) return { eligible:false, reason:"not_found" };
  return { eligible:true, reason:"eligible" };
};

const isPublicDeliveryEligible = (asset) => publicDeliveryVerdict(asset).eligible;

const mediaForAsset = (asset, displaySourcePath = asset?.source_relative_path) => {
  const descriptor = publicMediaDescriptorForPath(asset?.source_relative_path);
  if (!descriptor) return null;
  const ossPublicUrl = asset?.storage?.status === "uploaded" && /^https:\/\//i.test(String(asset?.storage?.public_url || ""))
    ? asset.storage.public_url
    : null;
  return {
    id:asset.asset_id,
    type:descriptor.type,
    url:ossPublicUrl || `/api/public/knowledge-media/${encodeURIComponent(asset.asset_id)}`,
    title:titleFor(asset),
    alt:`上海华美公开资料：${titleFor(asset)}`,
    source_relative_path:displaySourcePath,
    requires_verification:asset.source_verification_required === true
  };
};

/**
 * Resolve a citation source to an opaque, public preview descriptor. The client
 * never receives a filesystem path and a citation cannot promote an unapproved
 * document into a customer-facing attachment.
 */
export function previewPublicKnowledgeMediaForSource(sourceRelativePath = "") {
  const sourcePath = String(sourceRelativePath).trim();
  if (!sourcePath) return null;
  loadAssets();
  const asset = assetSourceCache?.get(sourcePath);
  if (!isPublicDeliveryEligible(asset)) return null;
  return mediaForAsset(asset);
}

export function attachPublicKnowledgeMediaPreviews(citations = []) {
  if (!Array.isArray(citations)) return [];
  return citations.map((citation) => {
    const preview = previewPublicKnowledgeMediaForSource(citation?.source_relative_path);
    if (!preview) return citation;
    return {
      ...citation,
      preview:{
        id:preview.id,
        type:preview.type,
        url:preview.url,
        title:preview.title,
        alt:preview.alt,
        requires_verification:preview.requires_verification
      }
    };
  });
}

export function selectPublicKnowledgeMedia({ message = "", citations = [], intent = "" } = {}) {
  const allowDelivery = MEDIA_REQUEST.test(String(message)) || AUTO_MEDIA_INTENTS.has(String(intent));
  if (!allowDelivery) return [];
  const assets = loadAssets();
  const text = String(message);
  const sourcePaths = new Set((Array.isArray(citations) ? citations : [])
    .map((item) => String(item?.source_relative_path || "").trim())
    .filter(Boolean));
  const citationMatchesAsset = (asset) => {
    const sourcePath = String(asset?.source_relative_path || "");
    return sourcePaths.has(sourcePath)
      || (sourcePath.startsWith("公开资料/") && sourcePaths.has(sourcePath.slice("公开资料/".length)));
  };
  const doctorFolderForPath = (path) => String(path).match(/^(?:公开资料\/)?医生介绍\/[^/]+\/([^/]+)\//)?.[1] || "";
  const isDoctorPath = (path) => /^(?:公开资料\/)?医生介绍\//.test(String(path));
  const isProjectPath = (path) => /^(?:公开资料\/)?(?:项目介绍|明星产品)\//.test(String(path));
  const doctorFolders = [...sourcePaths]
    .map(doctorFolderForPath)
    .filter(Boolean);
  const citedDoctorSourceFamily = [...sourcePaths].some((path) => path.startsWith("医生介绍/"))
    ? "published"
    : [...sourcePaths].some((path) => path.startsWith("公开资料/医生介绍/"))
      ? "public-materials"
      : null;
  const projectTerms = [
    ...projectTermsFromMessage(text),
    ...(text.includes("鼻") ? ["鼻"] : []),
    ...(text.includes("眼") ? ["眼"] : []),
    ...(text.includes("拉皮") || text.includes("微拉美") ? ["拉皮", "微拉美"] : []),
    ...(text.includes("脂肪") ? ["脂肪"] : []),
    ...(text.includes("热玛吉") ? ["热玛吉"] : []),
    ...(text.includes("光子") ? ["光子"] : []),
    ...(text.includes("水光") ? ["水光"] : []),
    ...(text.includes("吸脂") ? ["吸脂"] : [])
  ];
  // 用户点名品牌时，只发送该品牌的公开项目资料。不能因为“隆胸”这个
  // 泛词而混入无关的丰胸修复或其他品牌海报。
  const namedProjectTerms = ["特贝茨", "曼托", "傲诺拉", "璀璨"].filter((term) => text.includes(term));
  const hasDoctorContext = doctorFolders.length > 0;
  const isGenericDoctorProfile = doctorFolders.length > 0 && projectTerms.length === 0;
  const candidateAssets = [...assets.values()].filter((asset) => {
    if (!isPublicDeliveryEligible(asset)) return false;
    if (citationMatchesAsset(asset)) return true;
    if (doctorFolders.some((doctor) => {
      const sameDoctor = isDoctorPath(asset.source_relative_path) && asset.source_relative_path.includes(`/${doctor}/`);
      if (!sameDoctor) return false;
      if (citedDoctorSourceFamily === "published") return asset.source_relative_path.startsWith("医生介绍/");
      if (citedDoctorSourceFamily === "public-materials") return asset.source_relative_path.startsWith("公开资料/医生介绍/");
      return true;
    })) return true;
    // 项目海报不必先被文字检索命中：用户明确索取公开宣传图时，可在
    // 项目介绍白名单内按其点名的项目/品牌寻找对应图片。
    return !hasDoctorContext
      && isProjectPath(asset.source_relative_path)
      && projectTerms.length > 0
      && (namedProjectTerms.length
        ? namedProjectTerms.some((term) => asset.source_relative_path.includes(term))
        : projectTerms.some((term) => asset.source_relative_path.includes(term)));
  });
  return candidateAssets
    .map((asset) => {
      const path = asset.source_relative_path;
      let score = citationMatchesAsset(asset) ? 25 : 0;
      if (isGenericDoctorProfile && /个人总介绍/.test(path)) score += 160;
      else if (isGenericDoctorProfile && /个人介绍/.test(path)) score += 110;
      for (const term of projectTerms) if (path.includes(term)) score += 60;
      if (/手卡/.test(path)) score += 8;
      return { asset, score };
    })
    .sort((left, right) => right.score - left.score || left.asset.source_relative_path.localeCompare(right.asset.source_relative_path, "zh-CN"))
    .slice(0, 2)
    .map(({ asset }) => {
      const citationSourcePath = [...sourcePaths].find((sourcePath) => {
        const current = String(asset?.source_relative_path || "");
        return sourcePath === current || (current.startsWith("公开资料/") && sourcePath === current.slice("公开资料/".length));
      });
      return mediaForAsset(asset, citationSourcePath || asset.source_relative_path);
    })
    .filter(Boolean);
}

/** Resolve only opaque, policy-approved assets; callers never supply a path. */
export function resolvePublicKnowledgeMediaWithReason(assetId = "") {
  const id = String(assetId).trim();
  if (!/^asset_[a-z0-9]{16}$/i.test(id)) return { ok:false, reason:"not_found" };
  const asset = loadAssets().get(id);
  const verdict = publicDeliveryVerdict(asset);
  if (!verdict.eligible) return { ok:false, reason:verdict.reason };
  const path = localPathForAsset(asset);
  if (!path) return { ok:false, reason:"not_found" };
  const stats = statSync(path);
  const descriptor = publicMediaDescriptorForPath(path);
  if (!descriptor || !stats.isFile() || stats.size > maxBytesForDescriptor(descriptor)) return { ok:false, reason:"not_found" };
  return { ok:true, reason:"eligible", media:{ path, size:stats.size, mime:descriptor.mime, type:descriptor.type, asset_id:id, title:titleFor(asset) } };
}

export function resolvePublicKnowledgeMedia(assetId = "") {
  const result = resolvePublicKnowledgeMediaWithReason(assetId);
  return result.ok ? result.media : null;
}

export function getPublicKnowledgeMediaStatus() {
  const assets = loadAssets();
  const reasons = [...assets.values()].map((asset) => publicDeliveryVerdict(asset).reason);
  return {
    version:PUBLIC_KNOWLEDGE_MEDIA_VERSION,
    manifest_loaded:assets.size > 0,
    eligible_assets:reasons.filter((reason) => reason === "eligible").length,
    expired_assets:reasons.filter((reason) => reason === "expired").length,
    withdrawn_assets:reasons.filter((reason) => reason === "withdrawn").length,
    policy:"已审核公开资料包，以及医生介绍和项目介绍中的公开图片、PDF资料可对客预览；案例、术前术后、聊天与客户资料均不可对客发送"
  };
}
