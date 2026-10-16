// C-016 公开资料与媒体受控访问验收（夹具素材包驱动，自包含）。
// 用法：node handoff/tool-c016-media-access.mjs
// 说明：真实公开素材包与完整知识包不在分发包内，这里按项目已批准的"本地夹具"方式，
// 用带五种审核状态的夹具包验证白名单、对象范围、状态语义与凭据不外泄。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "handoff", "evidence-c016");
mkdirSync(OUT, { recursive:true });

const fixtureRoot = mkdtempSync(join(tmpdir(), "c016-media-fixture-"));
const assets = [
  { asset_id:"asset_fx00000000000001", source_relative_path:"医生介绍/整形外科/李健/李健隆胸宣传海报.png", file_name:"李健隆胸宣传海报.png", mime_type:"image/png", size_bytes:2048, review_status:"approved", reviewed_source:true, default_agent_action:"public_media_candidate" },
  { asset_id:"asset_fx00000000000002", source_relative_path:"项目介绍/公开资料.pdf", file_name:"公开资料.pdf", mime_type:"application/pdf", size_bytes:4096, review_status:"approved", reviewed_source:true, default_agent_action:"public_media_candidate" },
  { asset_id:"asset_fx00000000000003", source_relative_path:"医生介绍/整形外科/李健/已撤回海报.png", file_name:"已撤回海报.png", mime_type:"image/png", size_bytes:2048, review_status:"withdrawn", reviewed_source:true, default_agent_action:"public_media_candidate", withdrawn_at:"2026-01-01T00:00:00.000Z" },
  { asset_id:"asset_fx00000000000004", source_relative_path:"医生介绍/整形外科/李健/已过期海报.png", file_name:"已过期海报.png", mime_type:"image/png", size_bytes:2048, review_status:"expired", reviewed_source:true, default_agent_action:"public_media_candidate", expires_at:"2026-01-01T00:00:00.000Z" },
  { asset_id:"asset_fx00000000000005", source_relative_path:"公开资料/项目介绍/待审核资料.png", file_name:"待审核资料.png", mime_type:"image/png", size_bytes:2048, review_status:"pending", reviewed_source:false, default_agent_action:"public_media_candidate" },
  { asset_id:"asset_fx00000000000006", source_relative_path:"聊天记录/client0/客户照片.png", file_name:"客户照片.png", mime_type:"image/png", size_bytes:2048, review_status:"approved", reviewed_source:true, default_agent_action:"public_media_candidate" }
];
writeFileSync(join(fixtureRoot, "assets.jsonl"), assets.map((asset) => JSON.stringify(asset)).join("\n") + "\n", "utf8");
for (const asset of assets) {
  const file = join(fixtureRoot, asset.source_relative_path);
  mkdirSync(dirname(file), { recursive:true });
  writeFileSync(file, Buffer.alloc(asset.size_bytes, 1));
}
process.env.HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT = fixtureRoot;
process.env.HUAMEI_RAW_DATA_ROOT = fixtureRoot;

const media = await import(pathToFileURL(join(root, "server/knowledge-media.mjs")).href);
const checks = [];
const record = (id, name, detail) => { checks.push({ id, name, detail }); console.log(`  ✓ ${id} ${name}`); };

console.log("== C-016 公开资料与媒体受控访问 ==");
const approvedImage = "asset_fx00000000000001";
const approvedPdf = "asset_fx00000000000002";
const withdrawn = "asset_fx00000000000003";
const expired = "asset_fx00000000000004";
const pending = "asset_fx00000000000005";

const resolvedImage = media.resolvePublicKnowledgeMedia(approvedImage);
assert.ok(resolvedImage?.path, "已批准素材必须可解析");
assert.match(String(resolvedImage.mime || ""), /^image\//, "已批准图片必须按图片类型解析");
assert.equal(media.previewPublicKnowledgeMediaForSource("医生介绍/整形外科/李健/李健隆胸宣传海报.png")?.id, approvedImage, "已批准素材应能由引用路径生成预览入口");
assert.equal(media.resolvePublicKnowledgeMedia(approvedPdf)?.path !== undefined, true, "已批准的公开 PDF 必须可解析");
record("C-016-AC1", "链接只指向已批准且当前可访问对象", { 已批准图片:approvedImage, 类型:resolvedImage.mime });

for (const [label, id, expectedReason] of [["已撤回", withdrawn, "withdrawn"], ["已过期", expired, "expired"]]) {
  assert.equal(media.resolvePublicKnowledgeMedia(id), null, `${label}素材不得被解析为可发送对象`);
  const judgement = media.resolvePublicKnowledgeMediaWithReason(id);
  assert.equal(judgement?.ok, false, `${label}素材必须判定为不可用`);
  assert.equal(judgement?.reason, expectedReason, `${label}素材的不可用原因应为 ${expectedReason}`);
  const denial = media.publicKnowledgeMediaDenial(id);
  assert.ok(denial?.code, `${label}素材必须给出可定位的拒绝码`);
}
assert.equal(media.resolvePublicKnowledgeMedia(pending), null, "待审核素材不得对外发送");
assert.equal(media.resolvePublicKnowledgeMedia("asset_0000000000000000"), null, "不存在的素材必须拒绝");
assert.equal(media.previewPublicKnowledgeMediaForSource("聊天记录/client0/客户照片.png"), null, "非公开目录不得通过引用获得前台预览");
assert.equal(media.previewPublicKnowledgeMediaForSource("../../etc/passwd"), null, "路径穿越不得生成预览入口");
assert.equal(media.previewPublicKnowledgeMediaForSource("/etc/passwd"), null, "绝对路径不得生成预览入口");
record("C-016-AC2", "服务端校验对象范围，不接受任意文件路径", { 待审核:media.resolvePublicKnowledgeMediaWithReason(pending)?.reason || null, 聊天记录:null, 路径穿越:null });

const withdrawnDenial = media.publicKnowledgeMediaDenial(withdrawn);
const expiredDenial = media.publicKnowledgeMediaDenial(expired);
const missingDenial = media.publicKnowledgeMediaDenial("asset_0000000000000000");
assert.equal(withdrawnDenial.code, "PUBLIC_MEDIA_WITHDRAWN", "已撤回必须给出撤回提示码");
assert.equal(expiredDenial.code, "PUBLIC_MEDIA_EXPIRED", "已过期必须给出过期提示码");
assert.notEqual(withdrawnDenial.code, expiredDenial.code, "撤回与过期必须区分");
assert.ok(withdrawnDenial.message !== expiredDenial.message, "撤回与过期的用户提示必须可区分");
assert.ok(missingDenial === null || missingDenial.code !== withdrawnDenial.code, "不存在的素材不得与撤回混同");
record("C-016-AC3", "过期、撤回和不存在分别提供适当用户提示", { 撤回:withdrawnDenial, 过期:expiredDenial, 不存在:missingDenial });

const payloads = [resolvedImage, media.previewPublicKnowledgeMediaForSource("医生介绍/整形外科/李健/李健隆胸宣传海报.png"), media.getPublicKnowledgeMediaStatus()];
const serialized = JSON.stringify(payloads);
for (const forbidden of [fixtureRoot, "password", "secret", "credential", "access_key", "Authorization"]) {
  assert.equal(serialized.includes(forbidden), false, `媒体响应不得包含 ${forbidden}`);
}
assert.equal(serialized.includes("/tmp/") && serialized.includes("fixture"), false, "响应不得暴露素材包的文件系统位置");
record("C-016-AC4", "对象存储凭据不暴露到前端或可下载清单", { 状态摘要:Object.keys(media.getPublicKnowledgeMediaStatus()).slice(0, 6), 暴露检查:"通过" });

writeFileSync(join(OUT, "c016-media-access-report.json"), `${JSON.stringify({ generated_at:new Date().toISOString(), fixture_root:"临时夹具包（不提交）", checks }, null, 2)}\n`, "utf8");
console.log(`\nPASS：C-016 共 ${checks.length} 项验收检查通过；证据写入 handoff/evidence-c016/`);
