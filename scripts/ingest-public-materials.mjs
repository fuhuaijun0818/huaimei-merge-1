#!/usr/bin/env node
/**
 * Build a separately versioned, reviewed-public-materials package.
 *
 * Source files are never moved or modified. Images are OCR'd with macOS Vision,
 * PDFs with PDFKit, and all media receives an immutable content hash plus an
 * OSS upload manifest. The package is a release candidate: production use still
 * requires the existing public-release/GraphRAG admission workflow.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { knowledgeRecordContentSha256, officialKnowledgeRecordText } from "../server/huamei-knowledge.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(process.env.HUAMEI_PUBLIC_MATERIALS_ROOT || join(projectRoot, "..", "一期项目文件", "原始数据", "公开资料"));
const knowledgeRoot = resolve(process.env.HUAMEI_KNOWLEDGE_ROOT || join(projectRoot, "..", "一期项目文件", "华美智能体知识库_v1"));
const outputRoot = resolve(process.env.HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT || join(knowledgeRoot, "public-materials-v1"));
const ocrSource = resolve(projectRoot, "..", "agent_data_pipeline", "batch_ocr.swift");
const ocrBinary = resolve(projectRoot, ".local-data", "bin", "public-materials-vision-ocr");
const pdfSource = resolve(projectRoot, "scripts", "public-materials-pdf-extract.swift");
const pdfBinary = resolve(projectRoot, ".local-data", "bin", "public-materials-pdf-extract");
const IMAGE_EXTENSIONS = new Map([[".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"]]);
const VIDEO_EXTENSIONS = new Map([[".mp4", "video/mp4"], [".m4v", "video/x-m4v"], [".mov", "video/quicktime"]]);
const PDF_EXTENSION = ".pdf";
const DEFAULT_OSS_PREFIX = "huamei/public-materials/v1";
const MAX_OCR_WORKERS = Math.max(1, Math.min(8, Number(process.env.HUAMEI_PUBLIC_MATERIALS_OCR_WORKERS || 6)));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const contentHash = (path) => sha256(readFileSync(path));
const compact = (value = "", limit = 16_000) => String(value).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, limit);
const labelFor = (path) => String(path).replace(/\.[^.]+$/, "").replace(/[【】]/g, "").trim() || "公开资料";
const jsonLines = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const writeAtomic = (path, value) => {
  mkdirSync(dirname(path), { recursive:true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
};
const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, { cwd:projectRoot, stdio:["ignore", "pipe", "pipe"], ...options });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (value) => stdout.push(value));
  child.stderr.on("data", (value) => stderr.push(value));
  child.once("error", rejectRun);
  child.once("close", (code) => {
    if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
    else rejectRun(Object.assign(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`), { code:"PUBLIC_MATERIALS_PARSER_FAILED" }));
  });
});

const walk = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes:true })) {
      // Finder / macOS metadata is not business material and must never become
      // a retrievable record or an OSS object.
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
};
const extensionInfo = (path) => {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return { extension:extension.slice(1), media_type:"image", content_type:IMAGE_EXTENSIONS.get(extension) };
  if (extension === PDF_EXTENSION) return { extension:"pdf", media_type:"pdf", content_type:"application/pdf" };
  if (VIDEO_EXTENSIONS.has(extension)) return { extension:extension.slice(1), media_type:"video", content_type:VIDEO_EXTENSIONS.get(extension) };
  return { extension:extension.slice(1) || "none", media_type:"other", content_type:"application/octet-stream" };
};
const hierarchyFor = (sourceRelativePath) => sourceRelativePath.split("/").slice(0, -1);
const businessDomainFor = (parts = []) => {
  const text = parts.join("/");
  if (/医生介绍/.test(text)) return "医生与专家";
  if (/项目价格|价格表/.test(text)) return "项目与价格";
  if (/荟员|会员|权益/.test(text)) return "会员权益";
  if (/明星产品|项目介绍/.test(text)) return "项目与产品";
  return "公开宣传资料";
};
const verificationFor = (parts = []) => /(?:价格|权益|活动|政策|排班|医生)/.test(parts.join("/"));
const ossObjectKeyFor = (hash, sourceRelativePath) => {
  const safeSegments = String(sourceRelativePath).split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${String(process.env.HUAMEI_OSS_PREFIX || DEFAULT_OSS_PREFIX).replace(/^\/+|\/+$/g, "")}/${hash.slice(0, 2)}/${safeSegments}`;
};

const ensureBinary = async ({ source, binary, description }) => {
  if (!existsSync(source)) throw new Error(`${description}源码不存在：${source}`);
  const mustCompile = !existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs;
  if (!mustCompile) return binary;
  mkdirSync(dirname(binary), { recursive:true });
  await run("swiftc", [source, "-o", binary]);
  return binary;
};

const parseJsonLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const parseImages = async (images, temporaryRoot) => {
  if (!images.length) return new Map();
  const binary = await ensureBinary({ source:ocrSource, binary:ocrBinary, description:"Vision OCR" });
  const workers = Math.min(MAX_OCR_WORKERS, images.length);
  const shards = Array.from({ length:workers }, () => []);
  images.forEach((path, index) => shards[index % workers].push(path));
  const tasks = shards.map(async (paths, index) => {
    const listPath = join(temporaryRoot, `images-${index}.txt`);
    const outputPath = join(temporaryRoot, `images-${index}.jsonl`);
    writeFileSync(listPath, `${paths.join("\n")}\n`, "utf8");
    await run(binary, [listPath, outputPath]);
    return parseJsonLines(outputPath);
  });
  const parsed = (await Promise.all(tasks)).flat();
  return new Map(parsed.map((entry) => [resolve(entry.source_path), entry]));
};
const parsePdfs = async (pdfs) => {
  if (!pdfs.length) return new Map();
  const binary = await ensureBinary({ source:pdfSource, binary:pdfBinary, description:"PDFKit 文本解析" });
  const parsed = await Promise.all(pdfs.map(async (path) => JSON.parse(await run(binary, [path]))));
  return new Map(parsed.map((entry) => [resolve(entry.source_path), entry]));
};

if (!existsSync(sourceRoot)) throw new Error(`公开资料目录不存在：${sourceRoot}`);
const files = walk(sourceRoot);
const sourceFiles = files.map((path) => {
  const source_relative_path = `公开资料/${relative(sourceRoot, path).split("\\").join("/")}`;
  const info = extensionInfo(path);
  const hierarchy = hierarchyFor(source_relative_path);
  const sha = contentHash(path);
  return {
    absolute_path:path,
    source_relative_path,
    ...info,
    source_hierarchy:hierarchy,
    file_name:source_relative_path.split("/").at(-1),
    content_label:labelFor(source_relative_path.split("/").at(-1)),
    size_bytes:statSync(path).size,
    content_sha256:sha,
    business_domain:businessDomainFor(hierarchy),
    departments:hierarchy.length >= 3 && hierarchy[1] === "医生介绍" ? [hierarchy[2]] : [],
    source_verification_required:verificationFor(hierarchy)
  };
});
const images = sourceFiles.filter((item) => item.media_type === "image").map((item) => item.absolute_path);
const pdfs = sourceFiles.filter((item) => item.media_type === "pdf").map((item) => item.absolute_path);
const temporaryRoot = await mkdtemp(join(tmpdir(), "huamei-public-materials-"));
let imageOcr = new Map();
let pdfText = new Map();
try {
  imageOcr = await parseImages(images, temporaryRoot);
  pdfText = await parsePdfs(pdfs);
} finally {
  await rm(temporaryRoot, { recursive:true, force:true });
}

const assets = sourceFiles.map((item) => {
  const parsed = item.media_type === "image" ? imageOcr.get(item.absolute_path) : item.media_type === "pdf" ? pdfText.get(item.absolute_path) : null;
  const ocrText = compact(parsed?.text || "");
  const eligibleMedia = item.media_type === "image" || item.media_type === "pdf";
  return {
    asset_id:`asset_${sha256(`public-material-v1:${item.source_relative_path}`).slice(0, 16)}`,
    source_relative_path:item.source_relative_path,
    file_name:item.file_name,
    content_label:item.content_label,
    source_category:"公开资料",
    source_hierarchy:item.source_hierarchy,
    business_domain:item.business_domain,
    departments:item.departments,
    media_type:item.media_type,
    extension:item.extension,
    content_type:item.content_type,
    size_bytes:item.size_bytes,
    content_sha256:item.content_sha256,
    sensitivity:"public",
    review_status:"approved",
    reviewed_source:true,
    default_agent_action:eligibleMedia ? "public_media_candidate" : "metadata_only",
    ocr_status:item.media_type === "image" ? (parsed?.status === "ok" ? "extracted" : "error") : item.media_type === "pdf" ? (parsed?.status === "ok" ? "extracted" : "error") : "not_requested",
    ocr_line_count:item.media_type === "image" ? Number(parsed?.line_count || 0) : 0,
    ocr_text_char_count:ocrText.length,
    pdf_page_count:item.media_type === "pdf" ? Number(parsed?.page_count || 0) : 0,
    source_verification_required:item.source_verification_required,
    storage:eligibleMedia ? { status:"pending_oss_upload", provider:"aliyun_oss", object_key:ossObjectKeyFor(item.content_sha256, item.source_relative_path) } : { status:"not_applicable" }
  };
});
const assetBySource = new Map(assets.map((item) => [item.source_relative_path, item]));
const directories = new Map();
for (const asset of assets) {
  const parts = asset.source_relative_path.split("/").slice(0, -1);
  for (let size = 1; size <= parts.length; size += 1) {
    const source_relative_path = parts.slice(0, size).join("/");
    const current = directories.get(source_relative_path) || { source_relative_path, count:0 };
    current.count += 1;
    directories.set(source_relative_path, current);
  }
}
const directoryRecords = [...directories.values()].sort((left, right) => left.source_relative_path.localeCompare(right.source_relative_path, "zh-CN")).map((item) => {
  const hierarchy = item.source_relative_path.split("/");
  const material = {
    record_id:`kb_pub_dir_${sha256(item.source_relative_path).slice(0, 16)}`,
    record_type:"directory_overview",
    title:`华美公开资料目录：${hierarchy.join(" / ")}`,
    content:`该目录为已审核公开资料，当前包含 ${item.count} 个素材。可按目录名称、项目、医生或产品名称查找对应的公开介绍。`,
    tags:hierarchy,
    source_relative_path:item.source_relative_path,
    sensitivity:"public",
    verification_note:/价格|权益|活动|政策/.test(item.source_relative_path) ? "该目录素材已审核，但价格、活动和权益仍须按生效时间核验。" : "该目录素材已审核，可作为公开资料查找入口。"
  };
  return { ...material, record_content_sha256:knowledgeRecordContentSha256(material), text:officialKnowledgeRecordText(material) };
});
const contentRecords = assets.map((asset) => {
  const source = sourceFiles.find((item) => item.source_relative_path === asset.source_relative_path);
  const parsed = source?.media_type === "image" ? imageOcr.get(source.absolute_path) : source?.media_type === "pdf" ? pdfText.get(source.absolute_path) : null;
  const extracted = compact(parsed?.text || "");
  const recordType = source?.media_type === "image" ? "image_ocr" : source?.media_type === "pdf" ? "pdf_text" : "media_metadata";
  const material = {
    record_id:`kb_pub_${asset.asset_id.slice("asset_".length)}`,
    record_type:recordType,
    title:`公开资料：${asset.source_hierarchy.slice(1).join(" / ") || asset.content_label}`,
    content:extracted || `已审核公开${source?.media_type === "video" ? "视频" : "资料"}：${asset.content_label}。可按资料名称或目录定位原始公开素材。`,
    tags:[...asset.source_hierarchy, asset.content_label].filter(Boolean).slice(0, 16),
    source_relative_path:asset.source_relative_path,
    sensitivity:"public",
    verification_note:asset.source_verification_required ? "资料已审核；价格、活动、权益及排班仍须按当前生效信息核验。" : "资料已审核，可作为公开资料引用；医疗适用性须由专业医生面诊确认。"
  };
  return { ...material, record_content_sha256:knowledgeRecordContentSha256(material), text:officialKnowledgeRecordText(material) };
});
const knowledgeRecords = [...directoryRecords, ...contentRecords];
const uploadManifest = assets.filter((asset) => ["image", "pdf"].includes(asset.media_type)).map((asset) => ({
  asset_id:asset.asset_id,
  source_relative_path:asset.source_relative_path,
  absolute_path:resolve(sourceRoot, asset.source_relative_path.replace(/^公开资料\//, "")),
  content_sha256:asset.content_sha256,
  size_bytes:asset.size_bytes,
  content_type:asset.content_type,
  object_key:asset.storage.object_key,
  review_status:"approved",
  public_delivery_eligible:true,
  source_verification_required:asset.source_verification_required
}));
const countBy = (rows, key) => Object.fromEntries([...rows.reduce((map, row) => map.set(row[key], (map.get(row[key]) || 0) + 1), new Map()).entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
const manifest = {
  package_name:"华美公开资料知识包",
  version:"public-materials-v1",
  generated_at:new Date().toISOString(),
  source_root:sourceRoot,
  source_root_relative:"一期项目文件/原始数据/公开资料",
  review_status:"approved",
  source_review_attestation:"project-owner-confirmed-2026-09-03",
  asset_count:assets.length,
  knowledge_unit_count:knowledgeRecords.length,
  asset_count_by_media_type:countBy(assets, "media_type"),
  public_media_upload_count:uploadManifest.length,
  ocr_extracted_count:assets.filter((asset) => asset.ocr_status === "extracted").length,
  ocr_error_count:assets.filter((asset) => asset.ocr_status === "error").length,
  oss:{ provider:"aliyun_oss", status:"pending_configuration", upload_manifest:"oss-upload-manifest.jsonl" }
};
const report = {
  generated_at:manifest.generated_at,
  source_root:sourceRoot,
  review_status:"approved",
  totals:{ files:assets.length, knowledge_records:knowledgeRecords.length, upload_candidates:uploadManifest.length },
  by_media_type:manifest.asset_count_by_media_type,
  parser:{ image_ocr:"macOS Vision", pdf_text:"PDFKit", video:"metadata_only" },
  unresolved:[...assets.filter((asset) => asset.ocr_status === "error").map((asset) => ({ asset_id:asset.asset_id, source_relative_path:asset.source_relative_path, issue:"text_extraction_failed" }))],
  oss:{ status:"pending_configuration", required_environment:["HUAMEI_OSS_ENDPOINT", "HUAMEI_OSS_REGION", "HUAMEI_OSS_BUCKET", "HUAMEI_OSS_ACCESS_KEY_ID", "HUAMEI_OSS_ACCESS_KEY_SECRET", "HUAMEI_OSS_PUBLIC_BASE_URL"] }
};
writeAtomic(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeAtomic(join(outputRoot, "assets.jsonl"), jsonLines(assets));
const directoryRows = [...directories.values()].map((item) => ({
  directory_id:`dir_pub_${sha256(item.source_relative_path).slice(0, 16)}`,
  source_relative_path:item.source_relative_path,
  directory_name:item.source_relative_path.split("/").at(-1),
  depth:item.source_relative_path.split("/").length,
  source_category:"公开资料",
  business_domain:businessDomainFor(item.source_relative_path.split("/")),
  descendant_asset_count:item.count,
  sensitivity:"public",
  review_status:"approved",
  default_agent_action:"public_media_candidate"
}));
writeAtomic(join(outputRoot, "directories.jsonl"), jsonLines(directoryRows));
writeAtomic(join(outputRoot, "rag", "knowledge_units.jsonl"), jsonLines(knowledgeRecords));
writeAtomic(join(outputRoot, "oss-upload-manifest.jsonl"), jsonLines(uploadManifest));
writeAtomic(join(outputRoot, "reports", "ingestion-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output_root:outputRoot, ...manifest, report:join(outputRoot, "reports", "ingestion-report.json") }, null, 2)}\n`);
