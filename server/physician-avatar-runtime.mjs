import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const configuredRuntimeRoot = String(process.env.PHYSICIAN_AVATAR_RUNTIME_ROOT || "").trim();
const runtimeRoot = configuredRuntimeRoot ? resolve(configuredRuntimeRoot) : join(root, ".local-data", "physician-avatar");
if (dirname(runtimeRoot) === runtimeRoot) throw new Error("PHYSICIAN_AVATAR_RUNTIME_ROOT不能指向文件系统根目录");
const storePath = join(runtimeRoot, "runtime.json");
const mediaRoot = join(runtimeRoot, "media");
const uploadRoot = join(runtimeRoot, "uploads");
const configuredPhysicianReferenceRoot = String(process.env.PHYSICIAN_AVATAR_REFERENCE_ROOT || "").trim();
const physicianReferenceRoot = configuredPhysicianReferenceRoot ? resolve(configuredPhysicianReferenceRoot) : join(root, "assets", "physicians", "references");

const baseUrl = String(process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com").replace(/\/$/, "");
const apiKey = String(process.env.MINIMAX_API_KEY || "").trim();
const videoModel = String(process.env.MINIMAX_VIDEO_MODEL || "MiniMax-H3").trim();
const speechModel = String(process.env.MINIMAX_SPEECH_MODEL || "speech-2.8-hd").trim();
const callbackToken = String(process.env.MINIMAX_CALLBACK_TOKEN || "").trim();
const callbackPublicUrl = String(process.env.MINIMAX_CALLBACK_PUBLIC_URL || "").trim();
const realUserIds = new Set(String(process.env.MINIMAX_REAL_USER_IDS || "").split(",").map((item) => item.trim()).filter(Boolean));
const realCallsEnabled = String(process.env.MINIMAX_REAL_CALL_ENABLED || "false").toLowerCase() === "true";
const dailyRealJobLimit = Math.max(1, Number(process.env.MINIMAX_DAILY_REAL_JOB_LIMIT || 5));
const pollIntervalMs = Math.max(5000, Number(process.env.MINIMAX_POLL_INTERVAL_MS || 10000));
const maxPollErrors = Math.max(2, Number(process.env.MINIMAX_MAX_POLL_ERRORS || 8));
const PROMPT_TEMPLATE_VERSION = "physician-realistic-v2";

const PHYSICIANS = Object.freeze({
  "DR-001": { name:"沈砚舟", gender:"男", reference:"DR-001.png", referenceVersion:"portrait-v1", reviewStatus:"approved", faceCount:1, appearance:"成年男性，黑色短发向后梳理，不戴眼镜，白大褂内搭白衬衫与深红领带" },
  "DR-002": { name:"顾清和", gender:"女", reference:"DR-002.png", referenceVersion:"portrait-v2", contentHash:"sha256:74e489f0636a190117295848ee05d3c533afa9980984b593fc6903c2a7075940", reviewStatus:"approved", faceCount:1, appearance:"成年女性，黑发束于脑后并保留自然碎发，白大褂内搭深酒红V领刷手服" },
  "DR-003": { name:"周予安", gender:"男", reference:"DR-003.png", referenceVersion:"portrait-v1", reviewStatus:"approved", faceCount:1, appearance:"成年男性，黑色短发，戴深色圆框眼镜，白大褂内搭灰色衬衫与深红领带" },
  "DR-004": { name:"许知微", gender:"女", reference:"DR-004.png", referenceVersion:"portrait-v1", reviewStatus:"approved", faceCount:1, appearance:"成年女性，黑色侧分齐下巴短发，白大褂内搭浅色上衣" },
  "DR-005": { name:"林见月", gender:"女", reference:"DR-005.png", referenceVersion:"portrait-v1", reviewStatus:"approved", faceCount:1, appearance:"成年女性，黑色侧分波浪短发，白大褂内搭深酒红上衣" },
  "DR-006": { name:"陈屿川", gender:"男", reference:"DR-006.png", referenceVersion:"portrait-v1", reviewStatus:"approved", faceCount:1, appearance:"成年男性，盐胡色短发，保留自然胡须，白大褂内搭灰色衬衫与深红领带" }
});

const VOICES = Object.freeze([
  { id:"Chinese (Mandarin)_Gentleman", name:"自然温润男声", gender:"男", profile:{ speed:0.94, vol:1, pitch:0, emotion:"calm" }, disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_Wise_Women", name:"自然知性女声", gender:"女", profile:{ speed:0.96, vol:1, pitch:0, emotion:"calm" }, disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_Reliable_Executive", name:"沉稳专业男声", gender:"男", legacy:true, profile:{ speed:0.95, vol:1, pitch:0, emotion:"calm" }, disclosure:"系统合成音色，非医师本人原声" },
  { id:"Chinese (Mandarin)_News_Anchor", name:"专业播报女声", gender:"女", legacy:true, profile:{ speed:0.96, vol:1, pitch:0, emotion:"calm" }, disclosure:"系统合成音色，非医师本人原声" }
]);

const MODEL_CONSTRAINTS = Object.freeze({
  model:videoModel,
  api_version:"v2",
  generation_kind:"generative_reference_video",
  identity_guarantee:false,
  lip_sync_guarantee:false,
  modes:[
    { id:"reference_avatar", name:"参考人物口播", inputs:["reference_image","reference_audio"], ratios:["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"], resolutions:["768P","2K"], duration:{ min:4, max:15 } }
  ],
  media_limits:{
    image:{ mime:["image/jpeg","image/png","image/webp","image/heic","image/heif"], max_bytes:30*1024*1024, max_count:9 },
    audio:{ mime:["audio/mpeg","audio/mp3","audio/wav","audio/x-wav"], max_bytes:15*1024*1024, max_count:3, duration_seconds:{ min:2, max:15 } },
    request_max_bytes:64*1024*1024
  }
});

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STATUS_RANK = { queued:0, processing:1, completed:2, failed:2, cancelled:2 };
const BLOCKED_MARKETING = /(保证|百分之百|100%|绝对安全|零风险|永久有效|完全无痛|最安全|一定适合|包治|根治)/i;
const ALLOWED_UPLOAD_PURPOSES = new Set(["reference_image", "reference_audio"]);
let stateQueue = Promise.resolve();
let workerTimer = null;
let workerBusy = false;
const activeJobIds = new Set();

const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
const relativeStoragePath = (path) => relative(root, path).split(sep).join("/");
const absoluteStoragePath = (path) => resolve(root, path);
const providerHeaders = () => ({ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" });
const isDeleted = (record) => Boolean(record?.deletedAt);

async function withActiveJob(generationJobId, operation) {
  if (activeJobIds.has(generationJobId)) return false;
  activeJobIds.add(generationJobId);
  try { await operation(); return true; }
  finally { activeJobIds.delete(generationJobId); }
}

const initialState = () => ({
  schemaVersion:2,
  assets:Object.entries(PHYSICIANS).map(([physicianId, item]) => ({
    fileId:`FILE-${physicianId}-PORTRAIT`, userId:"tenant-demo", physicianId, purpose:"reference_image",
    filename:item.reference, mime:"image/png", status:"completed", source:"packaged_physician_portrait",
    storagePath:relativeStoragePath(join(physicianReferenceRoot, item.reference)), providerFileId:null,
    referenceVersion:item.referenceVersion, reviewStatus:item.reviewStatus, faceCount:item.faceCount,
    ...(item.contentHash ? { referenceContentHash:item.contentHash } : {}),
    createdAt:nowIso(), completedAt:nowIso()
  })),
  jobs:[], works:[], ledger:[]
});

function migrateState(state) {
  let changed = false;
  if (!Array.isArray(state.assets)) { state.assets = []; changed = true; }
  if (!Array.isArray(state.jobs)) { state.jobs = []; changed = true; }
  if (!Array.isArray(state.works)) { state.works = []; changed = true; }
  if (!Array.isArray(state.ledger)) { state.ledger = []; changed = true; }
  for (const [physicianId, item] of Object.entries(PHYSICIANS)) {
    const fileId = `FILE-${physicianId}-PORTRAIT`;
    let asset = state.assets.find((candidate) => candidate.fileId === fileId);
    if (!asset) {
      asset = initialState().assets.find((candidate) => candidate.fileId === fileId);
      state.assets.push(asset);
      changed = true;
      continue;
    }
    if (asset.source !== "packaged_physician_portrait") continue;
    const packagedMetadata = {
      physicianId, referenceVersion:item.referenceVersion, reviewStatus:item.reviewStatus,
      faceCount:item.faceCount, filename:item.reference,
      storagePath:relativeStoragePath(join(physicianReferenceRoot, item.reference)),
      ...(item.contentHash ? { referenceContentHash:item.contentHash } : {})
    };
    for (const [key, value] of Object.entries(packagedMetadata)) {
      if (asset[key] === undefined || asset[key] === null || asset[key] === "") { asset[key] = value; changed = true; }
    }
  }
  for (const job of state.jobs) {
    if (!job.referenceVersion) {
      job.referenceVersion = "legacy-unverified";
      job.identityReviewStatus = "needs_review";
      changed = true;
    }
    if (job.referenceVersion === "legacy-unverified" && !job.identityReviewStatus) {
      job.identityReviewStatus = "needs_review";
      changed = true;
    }
    if (!Object.hasOwn(job, "referenceContentHash")) { job.referenceContentHash = null; changed = true; }
    const work = state.works.find((candidate) => candidate.generationJobId === job.generationJobId);
    if (!work) continue;
    if (!work.metadata || typeof work.metadata !== "object") { work.metadata = {}; changed = true; }
    if (!work.metadata.referenceVersion) { work.metadata.referenceVersion = job.referenceVersion; changed = true; }
    if (!work.metadata.identityReviewStatus) { work.metadata.identityReviewStatus = job.identityReviewStatus || "needs_review"; changed = true; }
    if (!Object.hasOwn(work.metadata, "referenceContentHash")) { work.metadata.referenceContentHash = job.referenceContentHash || null; changed = true; }
  }
  if (state.schemaVersion !== 2) { state.schemaVersion = 2; changed = true; }
  return changed;
}

async function ensureRuntime() {
  await Promise.all([mkdir(mediaRoot, { recursive:true }), mkdir(uploadRoot, { recursive:true })]);
  try { await stat(storePath); }
  catch { await persistState(initialState()); }
}

async function readState() {
  await ensureRuntime();
  let state;
  try { state = JSON.parse(await readFile(storePath, "utf8")); }
  catch { const fresh = initialState(); await persistState(fresh); return fresh; }
  if (migrateState(state)) await persistState(state);
  return state;
}

async function persistState(state) {
  await mkdir(dirname(storePath), { recursive:true });
  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode:0o600 });
  await rename(temporaryPath, storePath);
}

function withState(operation) {
  const next = stateQueue.then(async () => {
    const state = await readState();
    const result = await operation(state);
    await persistState(state);
    return result;
  });
  stateQueue = next.catch(() => undefined);
  return next;
}

const publicAsset = (asset) => ({
  fileId:asset.fileId, physicianId:asset.physicianId, purpose:asset.purpose, filename:asset.filename,
  mime:asset.mime, size:asset.size || null, status:asset.status, providerFileId:asset.providerFileId || null,
  referenceVersion:asset.referenceVersion || null, reviewStatus:asset.reviewStatus || null,
  referenceContentHash:asset.referenceContentHash || asset.contentHash || null,
  faceCount:Number.isInteger(asset.faceCount) ? asset.faceCount : null,
  createdAt:asset.createdAt, completedAt:asset.completedAt || null
});

const publicWork = (work) => work && !isDeleted(work) ? ({
  workId:work.workId, generationJobId:work.generationJobId, providerTaskId:work.providerTaskId,
  userId:work.userId, physicianId:work.physicianId, avatarId:work.avatarId, voiceId:work.voiceId,
  title:work.title, status:work.status, simulation:work.simulation === true,
  videoUrl:work.videoPath ? `/api/local/physician-avatar/works/${work.workId}/video?physician_id=${encodeURIComponent(work.physicianId)}` : null,
  coverUrl:work.coverPath ? `/api/local/physician-avatar/works/${work.workId}/cover?physician_id=${encodeURIComponent(work.physicianId)}` : null,
  metadata:work.metadata, createdAt:work.createdAt
}) : null;

const publicJob = (job, state) => ({
  generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
  userId:job.userId, physicianId:job.physicianId, physicianName:job.physicianName,
  avatarId:job.avatarId, voiceId:job.voiceId, voiceName:job.voiceName, referenceFileId:job.referenceFileId,
  referenceVersion:job.referenceVersion || null, referenceContentHash:job.referenceContentHash || null,
  identityReviewStatus:job.identityReviewStatus || null,
  promptTemplateVersion:job.promptTemplateVersion || null,
  audioFileId:job.audioFileId || null, mode:job.mode, providerMode:job.providerMode,
  status:job.status, phase:job.phase, progress:job.progress, providerStatus:job.providerStatus || null,
  script:job.script, title:job.title, resolution:job.resolution,
  duration:job.providerDuration || job.requestedDuration || job.duration,
  requestedDuration:job.requestedDuration || job.duration, providerDuration:job.providerDuration || null,
  audioDurationMs:Number.isFinite(job.audioDurationMs) ? job.audioDurationMs : null, ratio:job.ratio,
  error:job.error || null, refundStatus:job.refundStatus || null, createdAt:job.createdAt, updatedAt:job.updatedAt,
  work:job.workId ? publicWork(state.works.find((work) => work.workId === job.workId && work.generationJobId === job.generationJobId && work.userId === job.userId && work.physicianId === job.physicianId && !isDeleted(work))) : null
});

function mayUseRealProvider(userId) {
  return Boolean(apiKey && realCallsEnabled && realUserIds.has(userId));
}

export async function getPhysicianAvatarRuntimeStatus(userId = "") {
  const state = await readState();
  return {
    configured:Boolean(apiKey), realCallsEnabled, realAccess:mayUseRealProvider(userId), provider:mayUseRealProvider(userId) ? "MiniMax" : "local_simulation",
    region:baseUrl.includes("minimaxi.com") ? "CN" : "Global",
    model:videoModel, speechModel, callbackConfigured:Boolean(callbackToken && callbackPublicUrl),
    polling:{ enabled:Boolean(workerTimer), intervalMs:pollIntervalMs, independentOfBrowser:true },
    counts:{ queued:state.jobs.filter((job) => !isDeleted(job) && job.status === "queued").length, processing:state.jobs.filter((job) => !isDeleted(job) && job.status === "processing").length, completed:state.jobs.filter((job) => !isDeleted(job) && job.status === "completed").length, failed:state.jobs.filter((job) => !isDeleted(job) && job.status === "failed").length },
    constraints:MODEL_CONSTRAINTS, voices:VOICES
  };
}

function validateCreatePayload(payload) {
  const errors = [];
  const physician = PHYSICIANS[payload.physicianId];
  const voice = VOICES.find((item) => item.id === payload.voiceId);
  const script = String(payload.script || "").trim();
  const mode = MODEL_CONSTRAINTS.modes.find((item) => item.id === (payload.mode || "reference_avatar"));
  const duration = Number(payload.duration);
  if (!physician) errors.push({ field:"physicianId", message:"请选择有效医师" });
  if (!voice) errors.push({ field:"voiceId", message:"请选择服务端允许的音色" });
  if (!mode) errors.push({ field:"mode", message:"当前模型不支持该生成模式" });
  if (script.length < 12 || script.length > 90) errors.push({ field:"script", message:"口播内容请输入12–90个字符，并控制在15秒内" });
  if (BLOCKED_MARKETING.test(script)) errors.push({ field:"script", message:"内容包含绝对化效果或安全承诺，请修改后再生成" });
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) errors.push({ field:"duration", message:"MiniMax-H3 V2 时长必须为4–15秒整数" });
  if (!mode?.resolutions.includes(payload.resolution)) errors.push({ field:"resolution", message:"清晰度不在当前模型允许范围" });
  if (!mode?.ratios.includes(payload.ratio)) errors.push({ field:"ratio", message:"画面比例不在当前模式允许范围" });
  if (payload.consentConfirmed !== true) errors.push({ field:"consentConfirmed", message:"必须确认已获得医师肖像与内容使用授权" });
  if (payload.generativeDisclosureConfirmed !== true) errors.push({ field:"generativeDisclosureConfirmed", message:"必须确认理解参考人物生成不保证逐帧身份一致" });
  return { errors, physician, voice, script, mode, duration };
}

async function packagedReferenceContentMatches(asset, physician) {
  if (asset?.source !== "packaged_physician_portrait" || !physician?.contentHash) return true;
  if ((asset.referenceContentHash || asset.contentHash) !== physician.contentHash) return false;
  try {
    const buffer = await readFile(absoluteStoragePath(asset.storagePath));
    const actualHash = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    return actualHash === physician.contentHash;
  } catch { return false; }
}

export async function createPhysicianAvatarJob(payload, { userId, idempotencyKey = "" }) {
  const validated = validateCreatePayload(payload);
  if (validated.errors.length) { const error = new Error("生成参数校验失败"); error.code = "VALIDATION_ERROR"; error.details = validated.errors; throw error; }
  return withState(async (state) => {
    const stableKey = String(idempotencyKey || "").trim().slice(0, 128);
    const replay = stableKey && state.jobs.find((job) => !isDeleted(job) && job.userId === userId && job.idempotencyKey === stableKey);
    if (replay) {
      const requestedReferenceFileId = String(payload.referenceFileId || `FILE-${payload.physicianId}-PORTRAIT`);
      const requestedTitle = String(payload.title || `${validated.physician.name}医师口播`).trim().slice(0, 60);
      const samePayload = replay.physicianId === payload.physicianId
        && replay.referenceFileId === requestedReferenceFileId
        && replay.title === requestedTitle
        && replay.script === validated.script
        && replay.voiceId === validated.voice.id
        && replay.mode === validated.mode.id
        && replay.resolution === payload.resolution
        && (replay.requestedDuration || replay.duration) === validated.duration
        && replay.ratio === payload.ratio;
      if (!samePayload) {
        const error = new Error("同一幂等键不能用于不同医师或不同生成参数"); error.code = "IDEMPOTENCY_PAYLOAD_MISMATCH"; throw error;
      }
      return { job:publicJob(replay, state), replayed:true };
    }
    const referenceFileId = String(payload.referenceFileId || `FILE-${payload.physicianId}-PORTRAIT`);
    const referenceAsset = state.assets.find((asset) => asset.fileId === referenceFileId);
    const assetOwned = referenceAsset && (referenceAsset.userId === userId || referenceAsset.userId === "tenant-demo");
    const packagedReferenceApproved = referenceAsset?.source !== "packaged_physician_portrait"
      || (referenceAsset.reviewStatus === "approved" && referenceAsset.faceCount === 1);
    const packagedReferenceContentVerified = referenceAsset
      ? await packagedReferenceContentMatches(referenceAsset, validated.physician)
      : false;
    if (!referenceAsset || !assetOwned || referenceAsset.physicianId !== payload.physicianId || referenceAsset.status !== "completed" || referenceAsset.purpose !== "reference_image" || !packagedReferenceApproved || !packagedReferenceContentVerified) {
      const error = new Error("参考人物素材不存在、未完成、未通过单人像审核或内容校验失败"); error.code = "INVALID_REFERENCE_ASSET"; throw error;
    }
    const createdAt = nowIso();
    const generationJobId = uid("GEN");
    const providerMode = mayUseRealProvider(userId) ? "real" : "simulation";
    const today = createdAt.slice(0, 10);
    if (providerMode === "real" && state.jobs.filter((item) => item.userId === userId && item.providerMode === "real" && item.createdAt.startsWith(today)).length >= dailyRealJobLimit) {
      const error = new Error(`当前测试账号今日真实生成任务已达到${dailyRealJobLimit}次上限`); error.code = "DAILY_REAL_JOB_LIMIT"; throw error;
    }
    const job = {
      generationJobId, providerTaskId:null, workId:null, userId, physicianId:payload.physicianId,
      physicianName:validated.physician.name, avatarId:`AVATAR-${payload.physicianId}`, voiceId:validated.voice.id,
      voiceName:validated.voice.name, referenceFileId, audioFileId:null, idempotencyKey:stableKey,
      referenceVersion:referenceAsset.referenceVersion || null,
      referenceContentHash:referenceAsset.referenceContentHash || referenceAsset.contentHash || null,
      identityReviewStatus:referenceAsset.reviewStatus || null,
      promptTemplateVersion:PROMPT_TEMPLATE_VERSION,
      mode:validated.mode.id, providerMode,
      status:"queued", phase:"waiting_worker", progress:5, providerStatus:null,
      title:String(payload.title || `${validated.physician.name}医师口播`).trim().slice(0, 60), script:validated.script,
      resolution:payload.resolution, duration:validated.duration, requestedDuration:validated.duration,
      providerDuration:null, audioDurationMs:null, ratio:payload.ratio,
      consentConfirmedAt:createdAt, generativeDisclosureConfirmedAt:createdAt,
      pollErrors:0, archiveAttempts:0, refundStatus:null, error:null, createdAt, updatedAt:createdAt, nextPollAt:createdAt
    };
    state.jobs.unshift(job);
    return { job:publicJob(job, state), replayed:false };
  });
}

export async function listPhysicianAvatarJobs({ userId, physicianId = "", limit = 50 }) {
  const state = await readState();
  return state.jobs.filter((job) => !isDeleted(job) && job.userId === userId && (!physicianId || job.physicianId === physicianId)).slice(0, Math.min(100, Math.max(1, Number(limit) || 50))).map((job) => publicJob(job, state));
}

export async function getPhysicianAvatarJob(generationJobId, userId, physicianId = "") {
  const state = await readState();
  const job = state.jobs.find((item) => !isDeleted(item) && item.generationJobId === generationJobId && item.userId === userId && (!physicianId || item.physicianId === physicianId));
  return job ? publicJob(job, state) : null;
}

export async function cancelPhysicianAvatarJob(generationJobId, userId, physicianId = "") {
  return withState(async (state) => {
    const job = state.jobs.find((item) => !isDeleted(item) && item.generationJobId === generationJobId && item.userId === userId && (!physicianId || item.physicianId === physicianId));
    if (!job) return null;
    if (!TERMINAL.has(job.status)) {
      job.status = "cancelled"; job.phase = "cancelled_by_user"; job.progress = 100; job.updatedAt = nowIso();
      job.error = { code:"CANCELLED_BY_USER", message:"已在本平台停止后续处理；供应商已提交任务可能仍会产生费用。" };
    }
    return publicJob(job, state);
  });
}

function setJobStatus(job, status, patch = {}) {
  if (isDeleted(job) || TERMINAL.has(job.status)) return false;
  if ((STATUS_RANK[status] ?? -1) < (STATUS_RANK[job.status] ?? -1)) return false;
  Object.assign(job, patch, { status, updatedAt:nowIso() });
  return true;
}

function deletionSafetyError(message, code = "UNSAFE_DELETE_PATH") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactJobMediaPath(job, kind, value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(job.generationJobId || ""))) throw deletionSafetyError("任务编号格式不允许用于媒体清理");
  const expectedNames = {
    video:`${job.generationJobId}.mp4`,
    cover:`${job.generationJobId}-cover.png`,
    audio:`${job.generationJobId}-input.mp3`
  };
  const expectedName = expectedNames[kind];
  const path = absoluteStoragePath(value);
  if (!expectedName || dirname(path) !== resolve(mediaRoot) || basename(path) !== expectedName) {
    throw deletionSafetyError(`拒绝清理不属于任务${job.generationJobId}的${kind}文件`);
  }
  return path;
}

function sameStoragePath(value, path) {
  if (!value) return false;
  try { return absoluteStoragePath(value) === path; }
  catch { return false; }
}

function ensureDeletionTargetsAreUnshared(state, job, work, audioAsset, targets) {
  const otherJobs = state.jobs.filter((item) => !isDeleted(item) && item.generationJobId !== job.generationJobId);
  const otherWorks = state.works.filter((item) => !isDeleted(item) && item.workId !== work?.workId);
  if (job.workId && otherJobs.some((item) => item.workId === job.workId)) {
    throw deletionSafetyError("关联作品仍被其他未删除任务引用", "DELETE_REFERENCE_CONFLICT");
  }
  if (job.audioFileId && otherJobs.some((item) => item.audioFileId === job.audioFileId || item.referenceFileId === job.audioFileId)) {
    throw deletionSafetyError("任务专属语音仍被其他未删除任务引用", "DELETE_REFERENCE_CONFLICT");
  }
  for (const target of targets) {
    if (otherWorks.some((item) => sameStoragePath(item.videoPath, target.path) || sameStoragePath(item.coverPath, target.path))) {
      throw deletionSafetyError("待清理媒体仍被其他未删除作品引用", "DELETE_REFERENCE_CONFLICT");
    }
    const referencedByAnotherJob = otherJobs.some((otherJob) => {
      const fileIds = [otherJob.referenceFileId, otherJob.audioFileId].filter(Boolean);
      return state.assets.some((asset) => fileIds.includes(asset.fileId) && !isDeleted(asset) && sameStoragePath(asset.storagePath, target.path));
    });
    if (referencedByAnotherJob) throw deletionSafetyError("待清理素材仍被其他未删除任务引用", "DELETE_REFERENCE_CONFLICT");
  }
}

async function deletionTargetsFor(state, job, work, audioAsset) {
  if (work && work.userId !== job.userId) {
    throw deletionSafetyError("任务与作品归属不一致，已拒绝清理", "DELETE_ASSOCIATION_CONFLICT");
  }
  if (work && work.generationJobId !== job.generationJobId) {
    throw deletionSafetyError("任务与作品关联不一致，已拒绝清理", "DELETE_ASSOCIATION_CONFLICT");
  }
  if (work && work.physicianId !== job.physicianId) {
    throw deletionSafetyError("任务与作品医师归属不一致，已拒绝清理", "DELETE_ASSOCIATION_CONFLICT");
  }
  if (job.audioFileId && (!audioAsset || audioAsset.userId !== job.userId || audioAsset.physicianId !== job.physicianId || audioAsset.source !== "minimax_t2a" || audioAsset.purpose !== "reference_audio")) {
    throw deletionSafetyError("任务专属语音关联不一致，已拒绝清理", "DELETE_ASSOCIATION_CONFLICT");
  }
  const [runtimeInfo, mediaInfo] = await Promise.all([lstat(runtimeRoot), lstat(mediaRoot)]);
  if (runtimeInfo.isSymbolicLink() || mediaInfo.isSymbolicLink() || !mediaInfo.isDirectory()) {
    throw deletionSafetyError("媒体目录包含不安全的符号链接或不是目录");
  }
  const [resolvedRuntimeRoot, resolvedMediaRoot] = await Promise.all([realpath(runtimeRoot), realpath(mediaRoot)]);
  if (resolvedMediaRoot !== join(resolvedRuntimeRoot, "media")) throw deletionSafetyError("媒体目录真实路径校验失败");
  const candidates = [
    ...(work?.videoPath ? [{ kind:"video", path:work.videoPath }] : []),
    ...(work?.coverPath ? [{ kind:"cover", path:work.coverPath }] : []),
    ...(audioAsset?.source === "minimax_t2a" && audioAsset?.purpose === "reference_audio" && audioAsset?.storagePath ? [{ kind:"audio", path:audioAsset.storagePath }] : []),
    { kind:"video", path:join(mediaRoot, `${job.generationJobId}.mp4`) },
    { kind:"cover", path:join(mediaRoot, `${job.generationJobId}-cover.png`) },
    { kind:"audio", path:join(mediaRoot, `${job.generationJobId}-input.mp3`) }
  ];
  const unique = new Map();
  for (const candidate of candidates) {
    const path = exactJobMediaPath(job, candidate.kind, candidate.path);
    if (!unique.has(path)) unique.set(path, { ...candidate, path });
  }
  const targets = [...unique.values()];
  ensureDeletionTargetsAreUnshared(state, job, work, audioAsset, targets);
  return targets;
}

async function removeDeletionTargets(targets) {
  const result = { video:0, cover:0, audio:0, alreadyMissing:0 };
  for (const target of targets) {
    try { await unlink(target.path); result[target.kind] += 1; }
    catch (error) {
      if (error?.code === "ENOENT") { result.alreadyMissing += 1; continue; }
      throw error;
    }
  }
  return result;
}

async function finalizePhysicianAvatarDeletion(generationJobId, userId, cleanup, error = null) {
  return withState(async (state) => {
    const job = state.jobs.find((item) => item.generationJobId === generationJobId && item.userId === userId && isDeleted(item));
    if (!job) return null;
    const completed = !error;
    job.deletionStatus = completed ? "completed" : "cleanup_failed";
    job.deletionCleanup = {
      status:job.deletionStatus,
      attempts:(job.deletionCleanup?.attempts || 0) + 1,
      removed:cleanup || job.deletionCleanup?.removed || { video:0, cover:0, audio:0, alreadyMissing:0 },
      error:error ? { code:error.code || "DELETE_CLEANUP_FAILED", message:String(error.message || "本地媒体清理失败").slice(0, 300) } : null,
      updatedAt:nowIso()
    };
    if (!completed) job.deletionNextRetryAt = new Date(Date.now() + Math.min(60000, 5000 * job.deletionCleanup.attempts)).toISOString();
    else job.deletionNextRetryAt = null;
    const audit = state.ledger?.find((item) => item.id === job.deletionAuditId);
    const work = job.workId ? state.works.find((item) => item.workId === job.workId && item.userId === userId && isDeleted(item)) : null;
    const audioAsset = job.audioFileId ? state.assets.find((item) => item.fileId === job.audioFileId && item.userId === userId && isDeleted(item)) : null;
    if (work) work.deletionStatus = job.deletionStatus;
    if (audioAsset) audioAsset.deletionStatus = job.deletionStatus;
    if (audit) {
      audit.status = completed ? "completed" : "cleanup_failed";
      audit.cleanup = job.deletionCleanup.removed;
      audit.updatedAt = job.deletionCleanup.updatedAt;
      if (job.deletionCleanup.error) audit.error = job.deletionCleanup.error;
      else delete audit.error;
    }
    return {
      generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
      deleted:true, deletedAt:job.deletedAt, cleanupStatus:job.deletionStatus, cleanup:job.deletionCleanup.removed,
      cleanupError:job.deletionCleanup.error
    };
  });
}

async function cleanupDeletedPhysicianAvatarJob(generationJobId, userId) {
  const state = await readState();
  const job = state.jobs.find((item) => item.generationJobId === generationJobId && item.userId === userId && isDeleted(item));
  if (!job) return null;
  if (job.deletionStatus === "completed") {
    return {
      generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
      deleted:true, deletedAt:job.deletedAt, cleanupStatus:"completed", cleanup:job.deletionCleanup?.removed || null
    };
  }
  const work = job.workId ? state.works.find((item) => item.workId === job.workId) : null;
  const audioAsset = job.audioFileId ? state.assets.find((item) => item.fileId === job.audioFileId) : null;
  try {
    const cleanup = await removeDeletionTargets(await deletionTargetsFor(state, job, work, audioAsset));
    return finalizePhysicianAvatarDeletion(generationJobId, userId, cleanup);
  } catch (error) {
    return finalizePhysicianAvatarDeletion(generationJobId, userId, null, error);
  }
}

export async function deletePhysicianAvatarJob(generationJobId, userId, physicianId = "") {
  let reserved = false;
  try {
    const marked = await withState(async (state) => {
      const job = state.jobs.find((item) => item.generationJobId === generationJobId && item.userId === userId && (!physicianId || item.physicianId === physicianId));
      if (!job) return null;
      const alreadyDeleted = isDeleted(job);
      if (!alreadyDeleted && !TERMINAL.has(job.status)) {
        const error = new Error("仅已完成、失败或已取消的任务可以删除"); error.code = "JOB_NOT_TERMINAL"; throw error;
      }
      if (activeJobIds.has(job.generationJobId)) {
        if (alreadyDeleted) return {
          generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
          deleted:true, alreadyDeleted:true, deletedAt:job.deletedAt, cleanupStatus:job.deletionStatus || "pending",
          cleanup:job.deletionCleanup?.removed || null, cleanupError:job.deletionCleanup?.error || null, cleanupInProgress:true
        };
        const error = new Error("任务仍被后台Worker占用，请稍后再删除"); error.code = "JOB_BUSY"; throw error;
      }
      if (!alreadyDeleted) {
        const deletedAt = nowIso();
        const work = job.workId ? state.works.find((item) => item.workId === job.workId) : null;
        const audioAsset = job.audioFileId ? state.assets.find((item) => item.fileId === job.audioFileId) : null;
        await deletionTargetsFor(state, job, work, audioAsset);
        state.ledger ||= [];
        const existingAudit = state.ledger.find((item) => item.type === "generation_job_deleted" && item.generationJobId === job.generationJobId && item.userId === userId);
        const auditId = existingAudit?.id || uid("LEDGER");
        if (!existingAudit) state.ledger.push({
          id:auditId, generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
          userId, physicianId:job.physicianId, type:"generation_job_deleted", originalStatus:job.status,
          providerMode:job.providerMode, status:"cleanup_pending", createdAt:deletedAt
        });
        Object.assign(job, { deletedAt, deletedBy:userId, deletionStatus:"pending", deletionAuditId:auditId, updatedAt:deletedAt });
        if (work) Object.assign(work, { deletedAt, deletedBy:userId, deletionStatus:"pending" });
        if (audioAsset) Object.assign(audioAsset, { deletedAt, deletedBy:userId, deletionStatus:"pending" });
      }
      activeJobIds.add(job.generationJobId);
      reserved = true;
      return {
        generationJobId:job.generationJobId, providerTaskId:job.providerTaskId || null, workId:job.workId || null,
        deleted:true, alreadyDeleted, deletedAt:job.deletedAt, cleanupStatus:job.deletionStatus || "pending",
        cleanup:job.deletionCleanup?.removed || null, cleanupError:job.deletionCleanup?.error || null
      };
    });
    if (marked?.cleanupInProgress) return marked;
    if (!marked || marked.cleanupStatus === "completed") return marked;
    const cleaned = await cleanupDeletedPhysicianAvatarJob(marked.generationJobId, userId);
    return cleaned ? { ...cleaned, alreadyDeleted:marked.alreadyDeleted } : marked;
  } finally {
    if (reserved) activeJobIds.delete(generationJobId);
  }
}

async function minimaxJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers:{ ...providerHeaders(), ...(options.headers || {}) }, signal:AbortSignal.timeout(Number(process.env.MINIMAX_TIMEOUT_MS || 60000)) });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw:text.slice(0, 500) }; }
  if (!response.ok || body.error || body.base_resp?.status_code > 0) {
    const error = new Error(body.error?.message || body.base_resp?.status_msg || `MiniMax请求失败（${response.status}）`);
    error.code = body.error?.type || `MINIMAX_HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return body;
}

async function synthesizeAudio(job) {
  const voice = VOICES.find((item) => item.id === job.voiceId);
  if (!voice) { const error = new Error("任务音色已不在服务端允许列表"); error.code = "UNSUPPORTED_TTS_VOICE"; throw error; }
  const result = await minimaxJson("/v1/t2a_v2", {
    method:"POST",
    body:JSON.stringify({
      model:speechModel, text:job.script, stream:false, language_boost:"Chinese", output_format:"hex",
      voice_setting:{ voice_id:job.voiceId, ...voice.profile },
      audio_setting:{ sample_rate:32000, bitrate:128000, format:"mp3", channel:1 }
    })
  });
  const audioHex = result.data?.audio;
  const audioLengthMs = Number(result.extra_info?.audio_length || 0);
  if (!audioHex) { const error = new Error("MiniMax未返回可用音频"); error.code = "EMPTY_TTS_AUDIO"; throw error; }
  if (!Number.isFinite(audioLengthMs) || audioLengthMs < 2000 || audioLengthMs > 15000) {
    const error = new Error(`语音时长${Math.round(audioLengthMs / 100) / 10}秒，不符合H3参考音频2–15秒限制`); error.code = "AUDIO_DURATION_OUT_OF_RANGE"; throw error;
  }
  const audioBuffer = Buffer.from(audioHex, "hex");
  if (!audioBuffer.length || audioBuffer.length > MODEL_CONSTRAINTS.media_limits.audio.max_bytes) { const error = new Error("语音文件为空或超过15MB"); error.code = "INVALID_AUDIO_SIZE"; throw error; }
  const audioPath = join(mediaRoot, `${job.generationJobId}-input.mp3`);
  await writeFile(audioPath, audioBuffer, { mode:0o600 });
  const providerDuration = Math.min(15, Math.max(4, Math.ceil(audioLengthMs / 1000)));
  return { audioPath, audioBuffer, audioLengthMs, providerDuration, traceId:result.trace_id || null, size:audioBuffer.length };
}

function physicianPrompt(job) {
  const appearance = PHYSICIANS[job.physicianId]?.appearance || "严格保持参考图中的脸型、五官比例、发型与服装";
  return [
    `克制、真实的医师正面口播。参考图中的${job.physicianName}是全片唯一人物与唯一身份依据；外观锚点：${appearance}。`,
    "全程保持同一人的脸型、五官比例、年龄感、发型和服装，不改变身份，不生成额外人物。",
    "参考音频是全片唯一台词与唯一声轨，仅做与原音频自然协调的口型和微小表情，不添加背景音乐、环境音、额外人声或第二声轨。",
    "固定机位，正面平视的肩部以上中近景，镜头不移动、不变焦、不切镜、不换景。",
    "保留真实皮肤纹理和自然面部细节，只有轻微呼吸、眨眼与克制手势；不磨皮、不美颜、不塑料感、不夸张表演。",
    "不添加字幕、贴纸、价格、疗效承诺、标识或水印。"
  ].join("");
}

async function submitH3Task(job, referenceAsset, audio) {
  const imageBuffer = await readFile(absoluteStoragePath(referenceAsset.storagePath));
  const content = [
    { type:"text", text:physicianPrompt(job) },
    { type:"image_url", image_url:{ url:`data:${referenceAsset.mime};base64,${imageBuffer.toString("base64")}` }, role:"reference_image" },
    { type:"audio_url", audio_url:{ url:`data:audio/mp3;base64,${audio.audioBuffer.toString("base64")}` }, role:"reference_audio" }
  ];
  const payload = { model:videoModel, content, resolution:job.resolution, duration:job.providerDuration, ratio:job.ratio };
  if (callbackPublicUrl && callbackToken) payload.callback_url = `${callbackPublicUrl}${callbackPublicUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(callbackToken)}`;
  const result = await minimaxJson("/v2/video_generation", { method:"POST", body:JSON.stringify(payload) });
  if (!result.task_id) { const error = new Error("MiniMax未返回task_id"); error.code = "MISSING_PROVIDER_TASK_ID"; throw error; }
  return String(result.task_id);
}

async function markFailed(generationJobId, error) {
  return withState(async (state) => {
    const job = state.jobs.find((item) => item.generationJobId === generationJobId);
    if (!job || isDeleted(job) || TERMINAL.has(job.status)) return;
    setJobStatus(job, "failed", { phase:"failed", progress:100, error:{ code:error.code || "GENERATION_FAILED", message:String(error.message || "生成失败").slice(0, 500) } });
    if (!job.refundRecordedAt) {
      job.refundRecordedAt = nowIso(); job.refundStatus = "manual_review";
      state.ledger.push({ id:uid("LEDGER"), generationJobId, userId:job.userId, type:"generation_failure_compensation", status:"manual_review", createdAt:job.refundRecordedAt });
    }
  });
}

async function processQueuedReal(jobSnapshot) {
  await withState(async (state) => {
    const job = state.jobs.find((item) => item.generationJobId === jobSnapshot.generationJobId);
    if (job && !isDeleted(job)) setJobStatus(job, "processing", { phase:"synthesizing_audio", progress:15 });
  });
  try {
    const state = await readState();
    const job = state.jobs.find((item) => item.generationJobId === jobSnapshot.generationJobId);
    if (!job || isDeleted(job) || TERMINAL.has(job.status)) return;
    const referenceAsset = state.assets.find((asset) => asset.fileId === job.referenceFileId);
    const audio = await synthesizeAudio(job);
    await withState(async (draft) => {
      const current = draft.jobs.find((item) => item.generationJobId === job.generationJobId);
      if (!current || isDeleted(current) || TERMINAL.has(current.status)) return;
      const audioFileId = uid("FILE");
      draft.assets.push({ fileId:audioFileId, userId:current.userId, physicianId:current.physicianId, purpose:"reference_audio", filename:basename(audio.audioPath), mime:"audio/mpeg", size:audio.size, durationMs:audio.audioLengthMs, status:"completed", source:"minimax_t2a", storagePath:relativeStoragePath(audio.audioPath), providerFileId:null, createdAt:nowIso(), completedAt:nowIso() });
      current.audioFileId = audioFileId; current.ttsTraceId = audio.traceId;
      current.audioDurationMs = audio.audioLengthMs; current.providerDuration = audio.providerDuration;
      current.promptTemplateVersion ||= PROMPT_TEMPLATE_VERSION;
      current.phase = "submitting_h3_v2"; current.progress = 35; current.updatedAt = nowIso();
    });
    const beforeSubmit = await readState();
    const currentBeforeSubmit = beforeSubmit.jobs.find((item) => item.generationJobId === job.generationJobId);
    if (!currentBeforeSubmit || isDeleted(currentBeforeSubmit) || TERMINAL.has(currentBeforeSubmit.status)) return;
    const providerTaskId = await submitH3Task(currentBeforeSubmit, referenceAsset, audio);
    await withState(async (draft) => {
      const current = draft.jobs.find((item) => item.generationJobId === job.generationJobId);
      if (!current || isDeleted(current)) return;
      current.providerTaskId = providerTaskId;
      if (TERMINAL.has(current.status)) { current.providerStatus ||= "queued"; current.updatedAt = nowIso(); return; }
      current.providerStatus = "queued"; current.phase = "provider_queued"; current.progress = 45; current.nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString(); current.updatedAt = nowIso();
    });
  } catch (error) { await markFailed(jobSnapshot.generationJobId, error); }
}

async function completeSimulation(jobSnapshot) {
  await withState(async (state) => {
    const job = state.jobs.find((item) => item.generationJobId === jobSnapshot.generationJobId);
    if (!job || isDeleted(job) || TERMINAL.has(job.status)) return;
    if (!job.providerTaskId) {
      setJobStatus(job, "processing", { providerTaskId:uid("MOCK"), providerStatus:"running", phase:"simulation_processing", progress:72, nextPollAt:new Date(Date.now() + 2500).toISOString() });
      return;
    }
    if (new Date(job.nextPollAt).getTime() > Date.now()) return;
    const workId = `WORK-${job.generationJobId}`;
    if (!state.works.some((work) => work.workId === workId)) state.works.unshift({
      workId, generationJobId:job.generationJobId, providerTaskId:job.providerTaskId, userId:job.userId,
      physicianId:job.physicianId, avatarId:job.avatarId, voiceId:job.voiceId, title:job.title,
      status:"completed", simulation:true, videoPath:null, coverPath:null,
      metadata:{
        model:videoModel, apiVersion:"v2", duration:job.providerDuration || job.requestedDuration || job.duration,
        requestedDuration:job.requestedDuration || job.duration, providerDuration:job.providerDuration || null,
        audioDurationMs:job.audioDurationMs || null, resolution:job.resolution, ratio:job.ratio,
        referenceFileId:job.referenceFileId, referenceVersion:job.referenceVersion || null,
        referenceContentHash:job.referenceContentHash || null,
        identityReviewStatus:job.identityReviewStatus || null, audioFileId:job.audioFileId || null,
        promptTemplateVersion:job.promptTemplateVersion || null,
        mime:null, size:null, note:"本地模拟未调用供应商，不生成媒体文件"
      }, createdAt:nowIso()
    });
    setJobStatus(job, "completed", { workId, providerStatus:"succeeded", phase:"work_created", progress:100, error:null });
  });
}

async function queryH3Task(providerTaskId) {
  const result = await minimaxJson(`/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`, { method:"GET" });
  if (!result.task) { const error = new Error("MiniMax H3 V2查询未返回task对象"); error.code = "INVALID_V2_QUERY_RESPONSE"; throw error; }
  return result.task;
}

async function downloadToFile(url, outputPath, maxBytes) {
  const response = await fetch(url, { redirect:"follow", signal:AbortSignal.timeout(120000) });
  if (!response.ok) { const error = new Error(`媒体归档下载失败（${response.status}）`); error.code = "MEDIA_DOWNLOAD_FAILED"; throw error; }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) { const error = new Error("供应商媒体超过本地归档大小限制"); error.code = "MEDIA_TOO_LARGE"; throw error; }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maxBytes) { const error = new Error("供应商媒体为空或超过大小限制"); error.code = "INVALID_MEDIA_SIZE"; throw error; }
  await writeFile(outputPath, buffer, { mode:0o600 });
  return { size:buffer.length, mime:response.headers.get("content-type") || "application/octet-stream" };
}

async function inspectGeneratedPng(coverPath, source) {
  try {
    const [info, content] = await Promise.all([stat(coverPath), readFile(coverPath)]);
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!info.isFile() || info.size < pngSignature.length || !pngSignature.every((byte, index) => content[index] === byte)) return null;
    return { path:coverPath, size:info.size, mime:"image/png", source };
  } catch { return null; }
}

async function safelyRemoveGeneratedFile(path) {
  try { await unlink(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export async function extractVideoCover(videoPath, coverPath, runCommand = execFileAsync) {
  const outputDir = dirname(coverPath);
  const quickLookPath = join(outputDir, `${basename(videoPath)}.png`);
  try {
    await runCommand("/usr/bin/qlmanage", ["-t", "-s", "960", "-o", outputDir, videoPath], {
      timeout:45000, killSignal:"SIGKILL", maxBuffer:1024*1024
    });
    await safelyRemoveGeneratedFile(coverPath);
    await rename(quickLookPath, coverPath);
    const quickLookCover = await inspectGeneratedPng(coverPath, "video_first_frame_thumbnail");
    if (quickLookCover) return quickLookCover;
  } catch { /* Linux没有Quick Look时继续使用FFmpeg。 */ }
  try { await safelyRemoveGeneratedFile(quickLookPath); } catch { /* 缩略图残留不应阻断FFmpeg兜底。 */ }
  try { await safelyRemoveGeneratedFile(coverPath); } catch { return null; }

  const configuredFfmpeg = String(process.env.FFMPEG_PATH || "").trim();
  const ffmpegExecutables = [...new Set([configuredFfmpeg, "ffmpeg"].filter(Boolean))];
  const ffmpegArguments = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-ss", "0", "-i", videoPath, "-map", "0:v:0", "-frames:v", "1",
    "-an", "-sn", "-dn", "-c:v", "png", "-compression_level", "3", coverPath
  ];
  for (const executable of ffmpegExecutables) {
    try {
      await runCommand(executable, ffmpegArguments, {
        timeout:45000, killSignal:"SIGKILL", maxBuffer:4*1024*1024
      });
      const ffmpegCover = await inspectGeneratedPng(coverPath, "video_first_frame_ffmpeg");
      if (ffmpegCover) return ffmpegCover;
    } catch { /* 配置路径不可用时继续尝试PATH中的ffmpeg。 */ }
    try { await safelyRemoveGeneratedFile(coverPath); } catch { return null; }
  }
  return null;
}

async function archiveAndCreateWork(generationJobId, providerTask) {
  const videoUrl = providerTask.content?.url;
  if (!videoUrl) { const error = new Error("供应商任务完成但没有视频地址"); error.code = "MISSING_VIDEO_URL"; throw error; }
  const videoPath = join(mediaRoot, `${generationJobId}.mp4`);
  const video = await downloadToFile(videoUrl, videoPath, 512*1024*1024);
  let cover = null;
  const providerCoverUrl = providerTask.content?.cover_url || providerTask.content?.coverUrl;
  const coverPath = join(mediaRoot, `${generationJobId}-cover.png`);
  if (providerCoverUrl) {
    try { const downloaded = await downloadToFile(providerCoverUrl, coverPath, 30*1024*1024); cover = { path:coverPath, ...downloaded, source:"provider_cover" }; } catch { cover = null; }
  }
  if (!cover) cover = await extractVideoCover(videoPath, coverPath);
  return withState(async (state) => {
    const job = state.jobs.find((item) => item.generationJobId === generationJobId);
    if (!job || isDeleted(job) || TERMINAL.has(job.status)) return job && !isDeleted(job) ? publicJob(job, state) : null;
    const workId = `WORK-${job.generationJobId}`;
    if (!state.works.some((work) => work.workId === workId)) state.works.unshift({
      workId, generationJobId:job.generationJobId, providerTaskId:job.providerTaskId, userId:job.userId,
      physicianId:job.physicianId, avatarId:job.avatarId, voiceId:job.voiceId, title:job.title,
      status:"completed", simulation:false, videoPath:relativeStoragePath(videoPath), coverPath:cover ? relativeStoragePath(cover.path) : null,
      metadata:{
        model:providerTask.model || videoModel, apiVersion:"v2",
        duration:job.providerDuration || job.requestedDuration || job.duration,
        requestedDuration:job.requestedDuration || job.duration, providerDuration:job.providerDuration || null,
        audioDurationMs:job.audioDurationMs || null,
        resolution:providerTask.resolution || job.resolution, ratio:providerTask.ratio || job.ratio,
        referenceFileId:job.referenceFileId, referenceVersion:job.referenceVersion || null,
        referenceContentHash:job.referenceContentHash || null,
        identityReviewStatus:job.identityReviewStatus || null, audioFileId:job.audioFileId || null,
        promptTemplateVersion:job.promptTemplateVersion || null,
        mime:video.mime, size:video.size,
        cover:cover ? { mime:cover.mime, size:cover.size, source:cover.source } : null,
        providerUpdatedAt:providerTask.updated_at || null
      },
      createdAt:nowIso()
    });
    setJobStatus(job, "completed", { workId, providerStatus:"succeeded", phase:"work_created", progress:100, providerResultUrl:null, error:null });
    return publicJob(job, state);
  });
}

async function reconcileProviderTask(generationJobId, providerTask = null) {
  const snapshot = await readState();
  const job = snapshot.jobs.find((item) => item.generationJobId === generationJobId);
  if (!job || isDeleted(job) || TERMINAL.has(job.status) || !job.providerTaskId) return;
  let task = providerTask;
  try { task = task || await queryH3Task(job.providerTaskId); }
  catch (error) {
    await withState(async (state) => {
      const current = state.jobs.find((item) => item.generationJobId === generationJobId);
      if (!current || isDeleted(current) || TERMINAL.has(current.status)) return;
      current.pollErrors = (current.pollErrors || 0) + 1; current.error = { code:error.code || "POLL_FAILED", message:error.message };
      current.nextPollAt = new Date(Date.now() + Math.min(60000, pollIntervalMs * current.pollErrors)).toISOString(); current.updatedAt = nowIso();
    });
    const refreshed = await readState();
    const current = refreshed.jobs.find((item) => item.generationJobId === generationJobId);
    if (current?.pollErrors >= maxPollErrors) await markFailed(generationJobId, Object.assign(new Error("供应商状态连续查询失败，已转人工处理"), { code:"POLL_RETRY_EXHAUSTED" }));
    return;
  }
  const providerStatus = String(task.status || "").toLowerCase();
  if (["queued","running"].includes(providerStatus)) {
    await withState(async (state) => {
      const current = state.jobs.find((item) => item.generationJobId === generationJobId);
      if (!current || isDeleted(current) || TERMINAL.has(current.status)) return;
      current.providerStatus = providerStatus; current.phase = providerStatus === "queued" ? "provider_queued" : "provider_running";
      current.progress = providerStatus === "queued" ? Math.max(current.progress, 45) : Math.max(current.progress, 68);
      current.pollErrors = 0; current.error = null; current.nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString(); current.updatedAt = nowIso();
    });
    return;
  }
  if (providerStatus === "succeeded") {
    await withState(async (state) => {
      const current = state.jobs.find((item) => item.generationJobId === generationJobId);
      if (!current || isDeleted(current) || TERMINAL.has(current.status)) return;
      current.providerStatus = "succeeded"; current.phase = "archiving_media"; current.progress = 88;
      current.providerResultUrl = task.content?.url || current.providerResultUrl; current.updatedAt = nowIso();
    });
    try { await archiveAndCreateWork(generationJobId, task); }
    catch (error) {
      const attempts = await withState(async (state) => {
        const current = state.jobs.find((item) => item.generationJobId === generationJobId);
        if (!current || isDeleted(current) || TERMINAL.has(current.status)) return 0;
        current.archiveAttempts = (current.archiveAttempts || 0) + 1; current.error = { code:error.code || "ARCHIVE_FAILED", message:error.message };
        current.nextPollAt = new Date(Date.now() + 15000 * current.archiveAttempts).toISOString(); current.updatedAt = nowIso();
        return current.archiveAttempts;
      });
      if (attempts >= 3) await markFailed(generationJobId, Object.assign(new Error("视频已生成，但连续归档失败，未创建作品，请人工补偿"), { code:"ARCHIVE_RETRY_EXHAUSTED" }));
    }
    return;
  }
  if (providerStatus === "failed") {
    await withState(async (state) => {
      const current = state.jobs.find((item) => item.generationJobId === generationJobId);
      if (current && !isDeleted(current) && !TERMINAL.has(current.status)) { current.providerStatus = "failed"; current.updatedAt = nowIso(); }
    });
    await markFailed(generationJobId, Object.assign(new Error(task.error?.message || "MiniMax生成失败"), { code:"PROVIDER_FAILED" }));
    return;
  }
  if (providerStatus === "cancelled") {
    await withState(async (state) => {
      const current = state.jobs.find((item) => item.generationJobId === generationJobId);
      if (current && !isDeleted(current)) setJobStatus(current, "cancelled", { providerStatus:"cancelled", phase:"provider_cancelled", progress:100, error:{ code:"PROVIDER_CANCELLED", message:"供应商已取消生成任务" } });
    });
  }
}

export async function reconcileMiniMaxCallback(providerTaskId) {
  const state = await readState();
  const job = state.jobs.find((item) => item.providerTaskId === String(providerTaskId));
  if (!job) return null;
  if (isDeleted(job)) return { generationJobId:job.generationJobId, providerTaskId:job.providerTaskId, status:job.status, deleted:true };
  await withActiveJob(job.generationJobId, () => reconcileProviderTask(job.generationJobId));
  return getPhysicianAvatarJob(job.generationJobId, job.userId);
}

export function verifyMiniMaxCallbackToken(value) {
  return Boolean(callbackToken && String(value || "") === callbackToken);
}

export async function preparePhysicianAvatarAsset(payload, userId) {
  const purpose = String(payload.purpose || "");
  const mime = String(payload.mime || "").toLowerCase();
  const size = Number(payload.size || 0);
  const limits = purpose === "reference_image" ? MODEL_CONSTRAINTS.media_limits.image : MODEL_CONSTRAINTS.media_limits.audio;
  if (!ALLOWED_UPLOAD_PURPOSES.has(purpose) || !limits.mime.includes(mime) || !Number.isInteger(size) || size <= 0 || size > limits.max_bytes) {
    const error = new Error("素材类型、MIME或文件大小不符合当前模型限制"); error.code = "INVALID_ASSET_METADATA"; throw error;
  }
  return withState(async (state) => {
    const fileId = uid("FILE");
    const extension = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("wav") ? ".wav" : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3" : ".jpg";
    const asset = { fileId, userId, physicianId:String(payload.physicianId || ""), purpose, filename:String(payload.filename || `${fileId}${extension}`).slice(0, 120), mime, size, expectedSize:size, status:"prepared", source:"user_upload", storagePath:relativeStoragePath(join(uploadRoot, `${fileId}${extension}`)), providerFileId:null, createdAt:nowIso() };
    state.assets.push(asset);
    return { ...publicAsset(asset), uploadUrl:`/api/local/physician-avatar/assets/${fileId}/content` };
  });
}

export async function savePhysicianAvatarAssetContent(fileId, userId, buffer, mime) {
  return withState(async (state) => {
    const asset = state.assets.find((item) => item.fileId === fileId && item.userId === userId);
    if (!asset || asset.status !== "prepared") { const error = new Error("素材不存在、归属不符或状态不允许上传"); error.code = "INVALID_ASSET_STATE"; throw error; }
    if (mime && mime !== asset.mime) { const error = new Error("上传MIME与申请信息不一致"); error.code = "ASSET_MIME_MISMATCH"; throw error; }
    if (!Buffer.isBuffer(buffer) || buffer.length !== asset.expectedSize) { const error = new Error("上传文件大小与申请信息不一致"); error.code = "ASSET_SIZE_MISMATCH"; throw error; }
    const isPng = asset.mime === "image/png" && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    const isJpeg = asset.mime === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
    const isWebp = asset.mime === "image/webp" && buffer.subarray(0,4).toString("ascii") === "RIFF" && buffer.subarray(8,12).toString("ascii") === "WEBP";
    const isHeif = ["image/heic","image/heif"].includes(asset.mime) && buffer.subarray(4,8).toString("ascii") === "ftyp";
    const isWav = ["audio/wav","audio/x-wav"].includes(asset.mime) && buffer.subarray(0,4).toString("ascii") === "RIFF" && buffer.subarray(8,12).toString("ascii") === "WAVE";
    const isMp3 = ["audio/mpeg","audio/mp3"].includes(asset.mime) && (buffer.subarray(0,3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));
    if (![isPng,isJpeg,isWebp,isHeif,isWav,isMp3].some(Boolean)) { const error = new Error("素材二进制签名与声明MIME不一致"); error.code = "ASSET_SIGNATURE_MISMATCH"; throw error; }
    await writeFile(absoluteStoragePath(asset.storagePath), buffer, { mode:0o600 });
    asset.status = "uploaded"; asset.size = buffer.length; asset.uploadedAt = nowIso();
    return publicAsset(asset);
  });
}

export async function completePhysicianAvatarAsset(fileId, userId) {
  return withState(async (state) => {
    const asset = state.assets.find((item) => item.fileId === fileId && item.userId === userId);
    if (!asset || asset.status !== "uploaded") { const error = new Error("素材不存在、归属不符或尚未上传完成"); error.code = "INVALID_ASSET_STATE"; throw error; }
    const info = await stat(absoluteStoragePath(asset.storagePath));
    if (info.size !== asset.expectedSize) { const error = new Error("服务端文件校验失败"); error.code = "ASSET_VERIFICATION_FAILED"; throw error; }
    asset.status = "completed"; asset.completedAt = nowIso();
    return publicAsset(asset);
  });
}

export async function getPhysicianAvatarWorkMedia(workId, userId, kind, physicianId = "") {
  const state = await readState();
  const work = state.works.find((item) => !isDeleted(item) && item.workId === workId && item.userId === userId && (!physicianId || item.physicianId === physicianId));
  if (!work) return null;
  const job = state.jobs.find((item) => !isDeleted(item) && item.generationJobId === work.generationJobId && item.workId === work.workId && item.userId === userId && item.physicianId === work.physicianId);
  if (!job) return null;
  const storedPath = kind === "cover" ? work.coverPath : work.videoPath;
  if (!storedPath) return null;
  const path = absoluteStoragePath(storedPath);
  if (!path.startsWith(`${resolve(runtimeRoot)}${sep}`)) return null;
  try {
    const info = await stat(path);
    return { path, size:info.size, mime:kind === "cover" ? "image/png" : (work.metadata?.mime || "video/mp4") };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function physicianAvatarWorkerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const state = await readState();
    const pendingDeletion = state.jobs.find((job) => isDeleted(job) && job.deletionStatus !== "completed" && (!job.deletionNextRetryAt || new Date(job.deletionNextRetryAt).getTime() <= Date.now()));
    if (pendingDeletion) {
      await withActiveJob(pendingDeletion.generationJobId, () => cleanupDeletedPhysicianAvatarJob(pendingDeletion.generationJobId, pendingDeletion.userId));
      return;
    }
    const due = state.jobs.find((job) => !isDeleted(job) && !TERMINAL.has(job.status) && (!job.nextPollAt || new Date(job.nextPollAt).getTime() <= Date.now()));
    if (!due) return;
    await withActiveJob(due.generationJobId, async () => {
      if (due.providerMode === "simulation") await completeSimulation(due);
      else if (due.status === "queued") await processQueuedReal(due);
      else if (due.status === "processing") await reconcileProviderTask(due.generationJobId);
    });
  } finally { workerBusy = false; }
}

export function startPhysicianAvatarWorker() {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => physicianAvatarWorkerTick().catch(() => undefined), pollIntervalMs);
  workerTimer.unref?.();
  physicianAvatarWorkerTick().catch(() => undefined);
  return workerTimer;
}

export function stopPhysicianAvatarWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
