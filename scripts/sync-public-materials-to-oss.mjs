#!/usr/bin/env node
/**
 * Idempotently sync reviewed public image/PDF files to Alibaba Cloud OSS.
 * No upload happens without --apply, a complete configuration and a public
 * delivery base URL. Credentials are read only from environment variables.
 */
import OSS from "ali-oss";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const knowledgeRoot = resolve(process.env.HUAMEI_KNOWLEDGE_ROOT || join(projectRoot, "..", "一期项目文件", "华美智能体知识库_v1"));
const packageRoot = resolve(process.env.HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT || join(knowledgeRoot, "public-materials-v1"));
const rawRoot = resolve(process.env.HUAMEI_RAW_DATA_ROOT || join(projectRoot, "..", "一期项目文件", "原始数据"));
const apply = process.argv.includes("--apply");
const assetsPath = join(packageRoot, "assets.jsonl");
const uploadManifestPath = join(packageRoot, "oss-upload-manifest.jsonl");
const reportPath = join(packageRoot, "reports", "oss-sync-report.json");
const required = [
  "HUAMEI_OSS_ENDPOINT",
  "HUAMEI_OSS_REGION",
  "HUAMEI_OSS_BUCKET",
  "HUAMEI_OSS_ACCESS_KEY_ID",
  "HUAMEI_OSS_ACCESS_KEY_SECRET",
  "HUAMEI_OSS_PUBLIC_BASE_URL"
];
const jsonLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const safePublicUrl = (base, key) => {
  const normalizedBase = String(base || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(normalizedBase)) throw new Error("HUAMEI_OSS_PUBLIC_BASE_URL 必须是 HTTPS 公共访问域名");
  return `${normalizedBase}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
};
const writeAtomic = (path, value) => {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
};

if (!existsSync(assetsPath) || !existsSync(uploadManifestPath)) {
  throw new Error("公开资料知识包尚未生成；请先运行 npm run knowledge:ingest-public-materials");
}
const assets = jsonLines(assetsPath);
const uploads = jsonLines(uploadManifestPath);
const missingConfig = required.filter((name) => !String(process.env[name] || "").trim());
const now = new Date().toISOString();
const baseReport = {
  generated_at:now,
  package_root:packageRoot,
  mode:apply ? "apply" : "dry_run",
  candidates:uploads.length,
  uploaded:0,
  skipped:0,
  failed:0,
  missing_configuration:missingConfig,
  errors:[]
};
if (!apply) {
  process.stdout.write(`${JSON.stringify({ ...baseReport, ready_to_apply:missingConfig.length === 0 }, null, 2)}\n`);
  process.exit(0);
}
if (missingConfig.length) {
  throw new Error(`OSS 上传配置不完整：${missingConfig.join("、")}`);
}

const client = new OSS({
  region:process.env.HUAMEI_OSS_REGION,
  endpoint:process.env.HUAMEI_OSS_ENDPOINT,
  bucket:process.env.HUAMEI_OSS_BUCKET,
  accessKeyId:process.env.HUAMEI_OSS_ACCESS_KEY_ID,
  accessKeySecret:process.env.HUAMEI_OSS_ACCESS_KEY_SECRET,
  secure:true,
  timeout:Math.max(10_000, Number(process.env.HUAMEI_OSS_TIMEOUT_MS || 60_000))
});
const uploadedByAssetId = new Map();
for (const item of uploads) {
  const sourcePath = resolve(rawRoot, String(item.source_relative_path || ""));
  if (!sourcePath.startsWith(`${rawRoot}/`) || !existsSync(sourcePath)) {
    baseReport.failed += 1;
    baseReport.errors.push({ asset_id:item.asset_id, code:"PUBLIC_MATERIAL_SOURCE_MISSING" });
    continue;
  }
  try {
    const result = await client.put(item.object_key, sourcePath, {
      headers:{
        "Content-Type":item.content_type,
        "Cache-Control":"public, max-age=31536000, immutable",
        "Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(String(item.source_relative_path).split("/").at(-1))}`,
        "x-oss-meta-content-sha256":item.content_sha256,
        "x-oss-meta-review-status":"approved"
      }
    });
    uploadedByAssetId.set(item.asset_id, {
      status:"uploaded",
      provider:"aliyun_oss",
      bucket:process.env.HUAMEI_OSS_BUCKET,
      object_key:item.object_key,
      public_url:safePublicUrl(process.env.HUAMEI_OSS_PUBLIC_BASE_URL, item.object_key),
      content_sha256:item.content_sha256,
      etag:String(result?.etag || "").replaceAll('"', "") || null,
      uploaded_at:now
    });
    baseReport.uploaded += 1;
  } catch (error) {
    baseReport.failed += 1;
    baseReport.errors.push({ asset_id:item.asset_id, code:error?.code || "OSS_UPLOAD_FAILED" });
  }
}
const updatedAssets = assets.map((asset) => uploadedByAssetId.has(asset.asset_id)
  ? { ...asset, storage:uploadedByAssetId.get(asset.asset_id) }
  : asset);
writeAtomic(assetsPath, `${updatedAssets.map((asset) => JSON.stringify(asset)).join("\n")}\n`);
writeAtomic(reportPath, `${JSON.stringify(baseReport, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(baseReport, null, 2)}\n`);
if (baseReport.failed) process.exitCode = 1;
