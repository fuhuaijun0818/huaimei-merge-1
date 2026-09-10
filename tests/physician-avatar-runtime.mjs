import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MINIMAX_REAL_CALL_ENABLED = "false";
const avatarRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-runtime-test-"));
process.env.PHYSICIAN_AVATAR_RUNTIME_ROOT = avatarRuntimeRoot;
const runtime = await import(`../server/physician-avatar-runtime.mjs?test=${Date.now()}`);
const runtimeSource = await readFile(new URL("../server/physician-avatar-runtime.mjs", import.meta.url), "utf8");
assert.match(runtimeSource, /data:audio\/mp3;base64/, "H3参考音频必须声明为MiniMax允许的MP3格式");
assert.doesNotMatch(runtimeSource, /data:audio\/mpeg;base64/, "不得把MP3声明成供应商会解析为.mpeg的MIME");
assert.doesNotMatch(runtimeSource, /prompt_optimizer|negative_prompt|subject_reference/, "H3 V2任务不得混入未接入字段");
assert.match(runtimeSource, /process\.env\.FFMPEG_PATH/, "Linux封面提取应支持配置FFmpeg可执行文件");
assert.match(runtimeSource, /"-ss",\s*"0"[\s\S]*"-frames:v",\s*"1"[\s\S]*coverPath/, "FFmpeg必须把视频第一帧直接输出到作品封面路径");
const userId = `test-avatar-${Date.now()}`;

const coverFixtureRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-cover-test-"));
const coverFixtureVideo = join(coverFixtureRoot, "fixture.mp4");
const coverFixtureOutput = join(coverFixtureRoot, "fixture-cover.png");
const coverPngSignature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
await writeFile(coverFixtureVideo, Buffer.from("stub-video"));
const originalFfmpegPath = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = "/test/bin/configured-ffmpeg";
const coverCommandCalls = [];
try {
  const extractedCover = await runtime.extractVideoCover(coverFixtureVideo, coverFixtureOutput, async (command, args, options) => {
    coverCommandCalls.push({ command, args, options });
    if (command === "/usr/bin/qlmanage") throw Object.assign(new Error("Quick Look unavailable"), { code:"ENOENT" });
    if (command === "/test/bin/configured-ffmpeg") {
      await writeFile(coverFixtureOutput, Buffer.from("partial-output"));
      throw Object.assign(new Error("configured FFmpeg failed"), { code:"EIO" });
    }
    assert.equal(command, "ffmpeg", "配置的FFmpeg失败后应尝试PATH中的ffmpeg");
    await assert.rejects(access(coverFixtureOutput), { code:"ENOENT" }, "失败命令产生的半成品封面必须先清理");
    assert.equal(args.at(-1), coverFixtureOutput, "FFmpeg输出必须是准确的作品封面路径");
    assert.ok(args.includes("-frames:v") && args.includes("1"), "FFmpeg只能提取第一帧");
    assert.ok(options.timeout > 0 && options.timeout <= 45000, "封面命令必须设置有限超时");
    await writeFile(coverFixtureOutput, Buffer.concat([coverPngSignature, Buffer.from("stub-png")]), { mode:0o600 });
  });
  assert.deepEqual(coverCommandCalls.map((call) => call.command), ["/usr/bin/qlmanage", "/test/bin/configured-ffmpeg", "ffmpeg"]);
  assert.equal(extractedCover.path, coverFixtureOutput);
  assert.equal(extractedCover.mime, "image/png");
  assert.equal(extractedCover.source, "video_first_frame_ffmpeg");
} finally {
  if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalFfmpegPath;
  await rm(coverFixtureRoot, { recursive:true, force:true });
}

const status = await runtime.getPhysicianAvatarRuntimeStatus(userId);
assert.equal(status.constraints.api_version, "v2");
assert.equal(status.constraints.model, "MiniMax-H3");
assert.deepEqual(status.constraints.modes[0].duration, { min:4, max:15 });
assert.equal(status.realAccess, false, "未显式开启真实调用时必须走本地模拟");
assert.ok(status.voices.some((voice) => voice.id === "Chinese (Mandarin)_Gentleman" && voice.profile?.emotion === "calm" && voice.profile.speed < 1), "应提供自然语速的温润男声");
assert.ok(status.voices.some((voice) => voice.id === "Chinese (Mandarin)_Wise_Women" && voice.profile?.emotion === "calm" && voice.profile.speed < 1), "应提供自然语速的女声");
assert.ok(status.voices.some((voice) => voice.id === "Chinese (Mandarin)_Reliable_Executive" && voice.legacy), "旧男声任务必须保持兼容");
assert.ok(status.voices.some((voice) => voice.id === "Chinese (Mandarin)_News_Anchor" && voice.legacy), "旧女声任务必须保持兼容");

const payload = {
  physicianId:"DR-001",
  title:"沈砚舟医师一般项目科普",
  script:"大家好，今天为大家介绍医美项目的一般流程，具体方案需要到院后由专业医师结合实际情况评估。",
  voiceId:"Chinese (Mandarin)_Reliable_Executive",
  mode:"reference_avatar",
  resolution:"768P",
  duration:12,
  ratio:"3:4",
  consentConfirmed:true,
  generativeDisclosureConfirmed:true
};

const created = await runtime.createPhysicianAvatarJob(payload, { userId, idempotencyKey:"same-request" });
assert.equal(created.job.status, "queued");
assert.equal(created.job.providerMode, "simulation");
assert.ok(created.job.generationJobId);
assert.equal(created.job.providerTaskId, null);
assert.equal(created.job.workId, null);
assert.equal(created.job.requestedDuration, 12);
assert.equal(created.job.providerDuration, null);
assert.equal(created.job.audioDurationMs, null);
assert.equal(created.job.referenceVersion, "portrait-v1");
assert.equal(created.job.identityReviewStatus, "approved");
assert.equal(created.job.promptTemplateVersion, "physician-realistic-v2");

const replayed = await runtime.createPhysicianAvatarJob(payload, { userId, idempotencyKey:"same-request" });
assert.equal(replayed.replayed, true);
assert.equal(replayed.job.generationJobId, created.job.generationJobId, "幂等请求不能重复创建任务");

const physicianBPayload = { ...payload, physicianId:"DR-002", title:"顾清和医师一般项目科普" };
const physicianB = await runtime.createPhysicianAvatarJob(physicianBPayload, { userId, idempotencyKey:"physician-b-request" });
assert.equal(physicianB.job.physicianId, "DR-002");
assert.equal(physicianB.job.avatarId, "AVATAR-DR-002");
assert.equal(physicianB.job.referenceVersion, "portrait-v2", "顾清和新任务必须绑定已审核的单人像v2");
assert.equal(physicianB.job.referenceContentHash, "sha256:74e489f0636a190117295848ee05d3c533afa9980984b593fc6903c2a7075940");
assert.equal(physicianB.job.identityReviewStatus, "approved");
const initialStorePath = join(avatarRuntimeRoot, "runtime.json");
const referenceReviewState = JSON.parse(await readFile(initialStorePath, "utf8"));
const physicianBReference = referenceReviewState.assets.find((asset) => asset.fileId === "FILE-DR-002-PORTRAIT");
physicianBReference.reviewStatus = "pending";
physicianBReference.faceCount = 2;
await writeFile(initialStorePath, JSON.stringify(referenceReviewState, null, 2));
await assert.rejects(
  runtime.createPhysicianAvatarJob(physicianBPayload, { userId, idempotencyKey:"unapproved-packaged-reference" }),
  (error) => error.code === "INVALID_REFERENCE_ASSET",
  "未审批或不是单人脸的内置参考图不得创建任务"
);
physicianBReference.reviewStatus = "approved";
physicianBReference.faceCount = 1;
await writeFile(initialStorePath, JSON.stringify(referenceReviewState, null, 2));
const physicianAJobs = await runtime.listPhysicianAvatarJobs({ userId, physicianId:"DR-001" });
const physicianBJobs = await runtime.listPhysicianAvatarJobs({ userId, physicianId:"DR-002" });
assert.ok(physicianAJobs.some((job) => job.generationJobId === created.job.generationJobId));
assert.ok(physicianAJobs.every((job) => job.physicianId === "DR-001"), "医师A列表只能包含医师A任务");
assert.ok(physicianBJobs.some((job) => job.generationJobId === physicianB.job.generationJobId));
assert.ok(physicianBJobs.every((job) => job.physicianId === "DR-002"), "医师B列表只能包含医师B任务");
assert.equal(await runtime.getPhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-001"), null, "医师A作用域不能读取医师B任务");
assert.equal(await runtime.cancelPhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-001"), null, "医师A作用域不能取消医师B任务");
await assert.rejects(
  runtime.createPhysicianAvatarJob(physicianBPayload, { userId, idempotencyKey:"same-request" }),
  (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH",
  "同一幂等键不得跨医师重放任务"
);

const pngSignature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const prepared = await runtime.preparePhysicianAvatarAsset({ purpose:"reference_image", physicianId:"DR-001", filename:"sample.png", mime:"image/png", size:pngSignature.length }, userId);
assert.equal(prepared.status, "prepared");
const uploaded = await runtime.savePhysicianAvatarAssetContent(prepared.fileId, userId, pngSignature, "image/png");
assert.equal(uploaded.status, "uploaded");
const completedAsset = await runtime.completePhysicianAvatarAsset(prepared.fileId, userId);
assert.equal(completedAsset.status, "completed");
await assert.rejects(
  runtime.createPhysicianAvatarJob({ ...physicianBPayload, referenceFileId:completedAsset.fileId }, { userId, idempotencyKey:"cross-physician-reference" }),
  (error) => error.code === "INVALID_REFERENCE_ASSET",
  "医师A的参考图不能用于创建医师B任务"
);

await assert.rejects(
  runtime.deletePhysicianAvatarJob(created.job.generationJobId, userId),
  (error) => error.code === "JOB_NOT_TERMINAL",
  "活动任务必须先取消才能删除"
);

const cancelled = await runtime.cancelPhysicianAvatarJob(created.job.generationJobId, userId);
assert.equal(cancelled.status, "cancelled");
const cancelledAgain = await runtime.cancelPhysicianAvatarJob(created.job.generationJobId, userId);
assert.equal(cancelledAgain.status, "cancelled", "终态任务不能被重复操作改变");

const deleted = await runtime.deletePhysicianAvatarJob(created.job.generationJobId, userId);
assert.equal(deleted.deleted, true);
assert.equal(deleted.alreadyDeleted, false);
assert.equal(await runtime.getPhysicianAvatarJob(created.job.generationJobId, userId), null, "删除任务不应再出现在详情中");
assert.equal((await runtime.listPhysicianAvatarJobs({ userId })).some((job) => job.generationJobId === created.job.generationJobId), false, "删除任务不应再出现在列表中");
assert.ok(await runtime.getPhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-002"), "删除医师A任务不能影响医师B任务");

await runtime.cancelPhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-002");
await runtime.deletePhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-002");
assert.equal(await runtime.getPhysicianAvatarJob(physicianB.job.generationJobId, userId, "DR-002"), null);

const deletedAgain = await runtime.deletePhysicianAvatarJob(created.job.generationJobId, userId);
assert.equal(deletedAgain.alreadyDeleted, true, "重复删除必须幂等");

const recreated = await runtime.createPhysicianAvatarJob(payload, { userId, idempotencyKey:"same-request" });
assert.equal(recreated.replayed, false, "已删除的幂等任务不得被重放");
assert.notEqual(recreated.job.generationJobId, created.job.generationJobId);
await runtime.cancelPhysicianAvatarJob(recreated.job.generationJobId, userId);
await runtime.deletePhysicianAvatarJob(recreated.job.generationJobId, userId);

const mediaFixture = await runtime.createPhysicianAvatarJob({ ...payload, title:"媒体清理隔离测试" }, { userId, idempotencyKey:"media-cleanup" });
await runtime.cancelPhysicianAvatarJob(mediaFixture.job.generationJobId, userId);
const fixtureJobId = mediaFixture.job.generationJobId;
const fixtureWorkId = `WORK-${fixtureJobId}`;
const fixtureAudioId = `FILE-${fixtureJobId}-AUDIO`;
const fixtureMediaRoot = join(avatarRuntimeRoot, "media");
const fixtureVideo = join(fixtureMediaRoot, `${fixtureJobId}.mp4`);
const fixtureCover = join(fixtureMediaRoot, `${fixtureJobId}-cover.png`);
const fixtureAudio = join(fixtureMediaRoot, `${fixtureJobId}-input.mp3`);
const referenceCanary = join(avatarRuntimeRoot, "uploads", "reference-canary.png");
await Promise.all([
  writeFile(fixtureVideo, Buffer.from("isolated-video")),
  writeFile(fixtureCover, Buffer.from("isolated-cover")),
  writeFile(fixtureAudio, Buffer.from("isolated-audio")),
  writeFile(referenceCanary, pngSignature)
]);
const fixtureStorePath = join(avatarRuntimeRoot, "runtime.json");
const fixtureState = JSON.parse(await readFile(fixtureStorePath, "utf8"));
const fixtureJob = fixtureState.jobs.find((job) => job.generationJobId === fixtureJobId);
Object.assign(fixtureJob, { status:"completed", phase:"work_created", workId:fixtureWorkId, audioFileId:fixtureAudioId, error:null });
fixtureState.works.unshift({
  workId:fixtureWorkId, generationJobId:fixtureJobId, providerTaskId:"TEST-PROVIDER", userId,
  physicianId:fixtureJob.physicianId, avatarId:fixtureJob.avatarId, voiceId:fixtureJob.voiceId,
  title:fixtureJob.title, status:"completed", simulation:false,
  videoPath:fixtureVideo, coverPath:fixtureCover, metadata:{ mime:"video/mp4", size:14 }, createdAt:new Date().toISOString()
});
fixtureState.assets.push({
  fileId:fixtureAudioId, userId, physicianId:fixtureJob.physicianId, purpose:"reference_audio",
  filename:`${fixtureJobId}-input.mp3`, mime:"audio/mpeg", status:"completed", source:"minimax_t2a",
  storagePath:fixtureAudio, createdAt:new Date().toISOString(), completedAt:new Date().toISOString()
});
await writeFile(fixtureStorePath, JSON.stringify(fixtureState, null, 2));
const fixturePublicJob = await runtime.getPhysicianAvatarJob(fixtureJobId, userId, "DR-001");
assert.match(fixturePublicJob.work.videoUrl, /physician_id=DR-001$/, "媒体地址必须携带医师作用域");
assert.ok(await runtime.getPhysicianAvatarWorkMedia(fixtureWorkId, userId, "video", "DR-001"), "正确医师作用域应可读取作品媒体");
assert.equal(await runtime.getPhysicianAvatarWorkMedia(fixtureWorkId, userId, "video", "DR-002"), null, "医师B作用域不能读取医师A作品媒体");

const [mediaDeleteFirst, mediaDeleteRetry] = await Promise.all([
  runtime.deletePhysicianAvatarJob(fixtureJobId, userId),
  runtime.deletePhysicianAvatarJob(fixtureJobId, userId)
]);
assert.ok(mediaDeleteFirst.deleted && mediaDeleteRetry.deleted, "并发重复删除必须都幂等成功");
for (const path of [fixtureVideo, fixtureCover, fixtureAudio]) {
  await assert.rejects(access(path), { code:"ENOENT" }, "任务专属媒体必须被物理清理");
}
await access(referenceCanary);
const stateAfterMediaDelete = JSON.parse(await readFile(fixtureStorePath, "utf8"));
assert.equal(stateAfterMediaDelete.ledger.filter((item) => item.type === "generation_job_deleted" && item.generationJobId === fixtureJobId).length, 1, "并发删除只能产生一条审计记录");

await assert.rejects(
  runtime.createPhysicianAvatarJob({ ...payload, script:"本项目保证百分之百安全而且永久有效" }, { userId, idempotencyKey:"blocked-copy" }),
  (error) => error.code === "VALIDATION_ERROR" && error.details.some((item) => item.field === "script")
);

const migrationRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-migration-test-"));
await mkdir(join(migrationRoot, "media"), { recursive:true });
const legacyMediaPath = join(migrationRoot, "media", "legacy-video.mp4");
await writeFile(legacyMediaPath, Buffer.from("legacy-media-must-remain"));
const legacyCreatedAt = new Date().toISOString();
await writeFile(join(migrationRoot, "runtime.json"), JSON.stringify({
  schemaVersion:1,
  assets:[{
    fileId:"FILE-DR-002-PORTRAIT", userId:"tenant-demo", physicianId:"DR-002", purpose:"reference_image",
    filename:"DR-002.png", mime:"image/png", status:"completed", source:"packaged_physician_portrait",
    storagePath:"assets/physicians/references/DR-002.png", createdAt:legacyCreatedAt, completedAt:legacyCreatedAt
  }],
  jobs:[{
    generationJobId:"GEN-LEGACY-DR002", providerTaskId:"PROVIDER-LEGACY", workId:"WORK-GEN-LEGACY-DR002",
    userId:"legacy-user", physicianId:"DR-002", physicianName:"顾清和", referenceFileId:"FILE-DR-002-PORTRAIT",
    status:"completed", createdAt:legacyCreatedAt, updatedAt:legacyCreatedAt
  }],
  works:[{
    workId:"WORK-GEN-LEGACY-DR002", generationJobId:"GEN-LEGACY-DR002", providerTaskId:"PROVIDER-LEGACY",
    userId:"legacy-user", physicianId:"DR-002", status:"completed", videoPath:legacyMediaPath,
    metadata:{ duration:4 }, createdAt:legacyCreatedAt
  }],
  ledger:[]
}, null, 2));
process.env.PHYSICIAN_AVATAR_RUNTIME_ROOT = migrationRoot;
const migrationRuntime = await import(`../server/physician-avatar-runtime.mjs?migration=${Date.now()}`);
await migrationRuntime.getPhysicianAvatarRuntimeStatus("legacy-user");
const migratedState = JSON.parse(await readFile(join(migrationRoot, "runtime.json"), "utf8"));
const migratedReference = migratedState.assets.find((asset) => asset.fileId === "FILE-DR-002-PORTRAIT");
const migratedJob = migratedState.jobs.find((job) => job.generationJobId === "GEN-LEGACY-DR002");
const migratedWork = migratedState.works.find((work) => work.generationJobId === "GEN-LEGACY-DR002");
assert.equal(migratedReference.referenceVersion, "portrait-v2");
assert.equal(migratedReference.referenceContentHash, "sha256:74e489f0636a190117295848ee05d3c533afa9980984b593fc6903c2a7075940");
assert.equal(migratedReference.reviewStatus, "approved");
assert.equal(migratedReference.faceCount, 1);
assert.equal(migratedJob.referenceVersion, "legacy-unverified", "历史任务不得被错认为新参考图生成");
assert.equal(migratedJob.referenceContentHash, null);
assert.equal(migratedJob.identityReviewStatus, "needs_review");
assert.equal(migratedWork.metadata.referenceVersion, "legacy-unverified");
assert.equal(migratedWork.metadata.referenceContentHash, null);
assert.equal(migratedWork.metadata.identityReviewStatus, "needs_review");
await access(legacyMediaPath);
await rm(migrationRoot, { recursive:true, force:true });

const providerRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-provider-test-"));
const tamperedRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-tampered-test-"));
const providerReferenceRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-reference-test-"));
const providerUserId = `provider-test-${Date.now()}`;
const controlledEnvKeys = [
  "PHYSICIAN_AVATAR_RUNTIME_ROOT", "PHYSICIAN_AVATAR_REFERENCE_ROOT", "MINIMAX_REAL_CALL_ENABLED", "MINIMAX_API_KEY", "MINIMAX_REAL_USER_IDS",
  "MINIMAX_BASE_URL", "MINIMAX_VIDEO_MODEL", "MINIMAX_SPEECH_MODEL", "MINIMAX_CALLBACK_PUBLIC_URL", "MINIMAX_CALLBACK_TOKEN"
];
const originalEnv = Object.fromEntries(controlledEnvKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const providerCalls = [];
try {
  const temporaryReferencePath = join(providerReferenceRoot, "DR-002.png");
  const sourceReferenceUrl = new URL("../assets/physicians/references/DR-002.png", import.meta.url);
  await copyFile(sourceReferenceUrl, temporaryReferencePath);
  const pristineReference = await readFile(temporaryReferencePath);
  await writeFile(temporaryReferencePath, Buffer.concat([pristineReference, Buffer.from("tampered")]));
  process.env.PHYSICIAN_AVATAR_RUNTIME_ROOT = tamperedRuntimeRoot;
  process.env.PHYSICIAN_AVATAR_REFERENCE_ROOT = providerReferenceRoot;
  process.env.MINIMAX_REAL_CALL_ENABLED = "false";
  const tamperedRuntime = await import(`../server/physician-avatar-runtime.mjs?tampered=${Date.now()}`);
  await assert.rejects(
    tamperedRuntime.createPhysicianAvatarJob({ ...payload, physicianId:"DR-002", title:"顾清和参考图校验", voiceId:"Chinese (Mandarin)_Wise_Women" }, { userId:"hash-test", idempotencyKey:"tampered-reference" }),
    (error) => error.code === "INVALID_REFERENCE_ASSET",
    "临时副本内容被篡改后必须拒绝创建任务"
  );
  await copyFile(sourceReferenceUrl, temporaryReferencePath);

  process.env.PHYSICIAN_AVATAR_RUNTIME_ROOT = providerRoot;
  process.env.PHYSICIAN_AVATAR_REFERENCE_ROOT = providerReferenceRoot;
  process.env.MINIMAX_REAL_CALL_ENABLED = "true";
  process.env.MINIMAX_API_KEY = "unit-test-key-never-sent";
  process.env.MINIMAX_REAL_USER_IDS = providerUserId;
  process.env.MINIMAX_BASE_URL = "https://provider.invalid";
  process.env.MINIMAX_VIDEO_MODEL = "MiniMax-H3";
  process.env.MINIMAX_SPEECH_MODEL = "speech-2.8-hd";
  process.env.MINIMAX_CALLBACK_PUBLIC_URL = "";
  process.env.MINIMAX_CALLBACK_TOKEN = "";
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    providerCalls.push({ url, options });
    if (url === "https://provider.invalid/v1/t2a_v2") return new Response(JSON.stringify({
      data:{ audio:"49443304000000000000" }, extra_info:{ audio_length:7201 }, trace_id:"TTS-TRACE-TEST", base_resp:{ status_code:0 }
    }), { status:200, headers:{ "content-type":"application/json" } });
    if (url === "https://provider.invalid/v2/video_generation") return new Response(JSON.stringify({ task_id:"PROVIDER-TASK-TEST", base_resp:{ status_code:0 } }), { status:200, headers:{ "content-type":"application/json" } });
    if (url === "https://provider.invalid/v2/query/video_generation/PROVIDER-TASK-TEST") return new Response(JSON.stringify({
      task:{ id:"PROVIDER-TASK-TEST", status:"succeeded", model:"MiniMax-H3", duration:12, resolution:"768P", ratio:"3:4", content:{ url:"https://media.invalid/video.mp4", cover_url:"https://media.invalid/cover.png" } },
      base_resp:{ status_code:0 }
    }), { status:200, headers:{ "content-type":"application/json" } });
    if (url === "https://media.invalid/video.mp4") return new Response(Buffer.from("mock-video"), { status:200, headers:{ "content-type":"video/mp4" } });
    if (url === "https://media.invalid/cover.png") return new Response(Buffer.from("mock-cover"), { status:200, headers:{ "content-type":"image/png" } });
    throw new Error(`测试拦截了未声明的外部请求: ${url}`);
  };

  const providerRuntime = await import(`../server/physician-avatar-runtime.mjs?provider=${Date.now()}`);
  const providerPayload = {
    ...payload, physicianId:"DR-002", title:"顾清和医师自然口播测试",
    voiceId:"Chinese (Mandarin)_Wise_Women", duration:12
  };
  const providerCreated = await providerRuntime.createPhysicianAvatarJob(providerPayload, { userId:providerUserId, idempotencyKey:"provider-duration" });
  assert.equal(providerCreated.job.providerMode, "real");
  assert.equal(providerCreated.job.referenceVersion, "portrait-v2");
  assert.equal(providerCreated.job.referenceContentHash, "sha256:74e489f0636a190117295848ee05d3c533afa9980984b593fc6903c2a7075940");
  await providerRuntime.physicianAvatarWorkerTick();

  const ttsCall = providerCalls.find((call) => call.url.endsWith("/v1/t2a_v2"));
  const h3Call = providerCalls.find((call) => call.url.endsWith("/v2/video_generation"));
  assert.ok(ttsCall && h3Call, "伪造供应商应收到TTS与H3提交请求");
  const ttsRequest = JSON.parse(ttsCall.options.body);
  const h3Request = JSON.parse(h3Call.options.body);
  assert.deepEqual(ttsRequest.voice_setting, {
    voice_id:"Chinese (Mandarin)_Wise_Women", speed:0.96, vol:1, pitch:0, emotion:"calm"
  }, "TTS应使用音色档案中的自然语速与calm情绪");
  assert.deepEqual(Object.keys(h3Request).sort(), ["content", "duration", "model", "ratio", "resolution"], "H3 V2只能发送已接入的合法字段");
  assert.equal(h3Request.duration, 8, "7.201秒音频应向上取整为8秒供应商时长");
  assert.deepEqual(h3Request.content.slice(1).map((item) => item.role), ["reference_image", "reference_audio"]);
  const generatedPrompt = h3Request.content[0].text;
  for (const phrase of ["唯一人物", "唯一声轨", "固定机位", "真实皮肤纹理", "不美颜", "不切镜", "不添加背景音乐", "不生成额外人物"]) {
    assert.match(generatedPrompt, new RegExp(phrase), `真实口播提示词应包含“${phrase}”`);
  }
  assert.doesNotMatch(JSON.stringify(h3Request), /prompt_optimizer|negative_prompt|subject_reference/);

  const submittedJob = await providerRuntime.getPhysicianAvatarJob(providerCreated.job.generationJobId, providerUserId, "DR-002");
  assert.equal(submittedJob.requestedDuration, 12);
  assert.equal(submittedJob.providerDuration, 8);
  assert.equal(submittedJob.audioDurationMs, 7201);
  assert.equal(submittedJob.duration, 8);
  const providerStorePath = join(providerRoot, "runtime.json");
  const providerState = JSON.parse(await readFile(providerStorePath, "utf8"));
  const storedProviderJob = providerState.jobs.find((job) => job.generationJobId === providerCreated.job.generationJobId);
  storedProviderJob.nextPollAt = new Date(0).toISOString();
  await writeFile(providerStorePath, JSON.stringify(providerState, null, 2));
  await providerRuntime.physicianAvatarWorkerTick();
  const completedProviderJob = await providerRuntime.getPhysicianAvatarJob(providerCreated.job.generationJobId, providerUserId, "DR-002");
  assert.equal(completedProviderJob.status, "completed");
  assert.equal(completedProviderJob.work.metadata.duration, 8, "作品时长必须使用TTS推导的providerDuration");
  assert.equal(completedProviderJob.work.metadata.requestedDuration, 12);
  assert.equal(completedProviderJob.work.metadata.providerDuration, 8);
  assert.equal(completedProviderJob.work.metadata.audioDurationMs, 7201);
  assert.equal(completedProviderJob.work.metadata.referenceFileId, completedProviderJob.referenceFileId);
  assert.equal(completedProviderJob.work.metadata.referenceVersion, "portrait-v2");
  assert.equal(completedProviderJob.work.metadata.referenceContentHash, completedProviderJob.referenceContentHash);
  assert.equal(completedProviderJob.work.metadata.identityReviewStatus, "approved");
  assert.equal(completedProviderJob.work.metadata.audioFileId, completedProviderJob.audioFileId);
  assert.equal(completedProviderJob.work.metadata.promptTemplateVersion, "physician-realistic-v2");
} finally {
  globalThis.fetch = originalFetch;
  for (const key of controlledEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(providerRoot, { recursive:true, force:true });
  await rm(tamperedRuntimeRoot, { recursive:true, force:true });
  await rm(providerReferenceRoot, { recursive:true, force:true });
}

console.log("✓ AI分身任务、素材、作品稳定ID模型已接入");
console.log("✓ 状态终态保护、幂等提交与敏感宣传门禁已通过");
console.log("✓ 未开启服务端总开关时真实API不会被调用");
await rm(avatarRuntimeRoot, { recursive:true, force:true });
