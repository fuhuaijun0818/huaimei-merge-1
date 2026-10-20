import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(
  process.env.HUAMEI_PUBLIC_MATERIALS_ROOT
    || join(projectRoot, "..", "..", "..", "公开资料0907")
);
const outputRoot = resolve(
  process.env.HUAMEI_PUBLIC_MEDIA_PACKAGE_ROOT
    || join(projectRoot, ".local-data", "public-materials-media")
);
const assetsPath = join(outputRoot, "assets.jsonl");
const manifestPath = join(outputRoot, "manifest.json");
const MEDIA = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"]
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
};
const sourceFiles = (await walk(sourceRoot)).filter((path) => MEDIA.has(extname(path).toLowerCase()));
const assets = [];
for (const path of sourceFiles) {
  const relativePath = relative(sourceRoot, path).split("\\").join("/");
  const sourceRelativePath = `公开资料/${relativePath}`;
  const extension = extname(path).toLowerCase();
  const buffer = await readFile(path);
  const stats = await stat(path);
  const mediaType = extension === ".pdf" ? "pdf" : "image";
  assets.push({
    asset_id:`asset_${sha256(`public-material-v1:${sourceRelativePath}`).slice(0, 16)}`,
    source_relative_path:sourceRelativePath,
    file_name:relativePath.split("/").at(-1),
    content_label:relativePath.replace(/\.[^.]+$/, "").replace(/[【】]/g, "").trim(),
    source_category:"公开资料",
    source_hierarchy:sourceRelativePath.split("/").slice(0, -1),
    business_domain:/医生介绍/.test(sourceRelativePath) ? "医生与专家"
      : /项目介绍|明星产品/.test(sourceRelativePath) ? "项目与产品"
        : "公开宣传资料",
    departments:[],
    media_type:mediaType,
    extension:extension.slice(1),
    content_type:MEDIA.get(extension),
    size_bytes:stats.size,
    content_sha256:sha256(buffer),
    sensitivity:"public",
    review_status:"approved",
    reviewed_source:true,
    default_agent_action:"public_media_candidate",
    ocr_status:"not_requested",
    source_verification_required:/(?:医生介绍|项目介绍|项目价格|政策|权益|活动|明星产品)/.test(sourceRelativePath),
    storage:{ status:"not_uploaded", provider:"local" }
  });
}
await mkdir(dirname(assetsPath), { recursive:true });
await writeFile(assetsPath, `${assets.map((asset) => JSON.stringify(asset)).join("\n")}\n`, "utf8");
const manifest = {
  version:"public-materials-media-local-v1",
  created_at:new Date().toISOString(),
  source_root:sourceRoot,
  review_status:"approved",
  source_review_attestation:"Local development media manifest generated from the reviewed public materials directory; OCR text remains in the GraphRAG catalog.",
  asset_count:assets.length,
  media_asset_count:assets.length,
  note:"This manifest contains only opaque media descriptors and content hashes. It does not create or replace knowledge records."
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ source_root:sourceRoot, assets:assetsPath, manifest:manifestPath, asset_count:assets.length }, null, 2));
