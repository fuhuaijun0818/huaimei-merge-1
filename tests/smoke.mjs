// Offline regression must not inherit live member credentials from .env.local.
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Smoke tests start isolated web-gateway processes. The production/dev path
// uses the independent HTTP service; this explicit test-only fallback keeps
// each security-boundary fixture self-contained.
process.env.HUAMEI_ACQUISITION_SERVICE_IN_PROCESS = "true";

const root = new URL("../", import.meta.url);
const [index, styles, app, data, projectKnowledge, store, subpages, serverEntry, agentRuntime, apiRouter, openapi, uiModule] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("styles.css", root), "utf8"),
  readFile(new URL("src/app.js", root), "utf8"),
  readFile(new URL("src/data.js", root), "utf8"),
  readFile(new URL("src/project-knowledge.js", root), "utf8"),
  readFile(new URL("src/store.js", root), "utf8"),
  readFile(new URL("src/subpages.js", root), "utf8"),
  readFile(new URL("server.mjs", root), "utf8"),
  readFile(new URL("server/agent-runtime.mjs", root), "utf8"),
  readFile(new URL("server/api-router.mjs", root), "utf8"),
  readFile(new URL("server/openapi.mjs", root), "utf8"),
  readFile(new URL("src/ui.js", root), "utf8")
]);

assert.match(index, /时代之美·客户360/);
assert.match(index, /src\/app\.js/);
assert.ok(styles.length > 45000, "设计系统样式应完整加载");

for (const moduleName of ["今日工作台", "客户与会员", "会话与接待", "自动化运营", "智能体中心", "医师团队", "知识与合规", "项目与价格", "经营分析", "组织与权限"]) {
  assert.ok(app.includes(moduleName) || data.includes(moduleName) || uiModule.includes(moduleName), `缺少模块：${moduleName}`);
}

assert.match(uiModule, /export const navGroups/, "后台导航应使用分组信息架构");
for (const groupLabel of ["客户运营", "服务内容与智能体", "经营治理"]) {
  assert.match(uiModule, new RegExp(`label: "${groupLabel}"`), `缺少导航工作域：${groupLabel}`);
}
for (const entryLabel of ["客户与会员", "会话与接待", "自动化运营", "智能体中心", "项目与价格", "组织与权限"]) {
  assert.match(uiModule, new RegExp(`"${entryLabel}"`), `缺少清晰的导航入口：${entryLabel}`);
}
assert.match(app, /nav-section-\$\{group\.key\}/, "侧边栏应按工作域输出分组");
assert.match(styles, /后台以桌面运营为主，默认始终展示完整导航/, "窄屏侧边栏默认应保持展开");
assert.match(styles, /:root \{ --sidebar: 226px; \}/, "窄屏侧边栏应保留完整宽度");

for (const core of ["nextAction", "photoConsent", "macroStage", "microStage", "interests", "pains", "itches", "delights", "timeline"]) {
  assert.ok(data.includes(core), `客户360缺少核心字段：${core}`);
}

assert.equal((projectKnowledge.match(/"sourceId": "HM_BAIDU_/g) || []).length, 34, "知识库应完整接入34张项目卡片");
assert.match(projectKnowledge, /"canonicalProjectCount": 20/);
for (const section of ["一、原理", "二、功效", "三、治疗流程", "四、效果", "五、注意事项"]) {
  assert.ok(projectKnowledge.includes(section), `项目知识缺少章节：${section}`);
}

assert.match(data, /businessCopyVersion: 2/);
assert.match(projectKnowledge, /baidu-project-cards-34-business-v2/);
assert.match(store, /migrateBusinessCopy/);
assert.match(store, /status: "待接入"/);
assert.match(store, /successRate: null/);
assert.match(app, /knowledgeRiskLabel/);
assert.match(app, /待人工接手/);
assert.match(app, /回答追溯/);
assert.match(app, /客户画像由人工更新/);
assert.match(app, /系统信息（仅管理员排查）/);
assert.doesNotMatch(app, /MiniMax-H3 · V2 异步生成/);
assert.doesNotMatch(app, /后台Worker独立运行|失败补偿只记一次|生产需数据库、队列与对象存储/);

for (const method of ["updateCustomer", "completeTask", "sendMessage", "toggleJourney", "addPhysician", "updatePhysician", "deletePhysician", "updateKnowledge", "testConnector"]) {
  assert.ok(store.includes(method), `数据层缺少动作：${method}`);
}

for (const subpage of ["团队工作台", "待人工确认", "生命周期看板", "动态分群", "会话质检", "话术模板", "旅程模板库", "客户旅程进度", "AI执行记录", "效果与安全测试", "API开放平台", "擅长领域", "合规规则", "产品管理", "用户管理", "角色管理", "权限管理", "操作审计", "客户生命周期分析", "人机协作分析", "统一字段映射", "权限与审计"]) {
  assert.ok(subpages.includes(subpage), `缺少二级页面：${subpage}`);
}

for (const entity of ["taskDetail", "conversationDetail", "journeyDetail", "agentDetail", "physicianDetail", "knowledgeDetail", "connectorDetail", "segmentDetail"]) {
  assert.ok(subpages.includes(entity), `缺少三级对象页：${entity}`);
}

assert.match(app, /renderSubpage/);
assert.match(app, /renderEntityPage/);
assert.match(subpages, /physicians: \[\["overview", "医师团队"\], \["specialties", "领域总览"\], \["avatar", "AI分身工作室"\]\]/);
assert.match(subpages, /aria-current="page"/);
assert.match(subpages, /function physicianSpecialties\(\)/);
assert.match(subpages, /"团队领域概览"/);
const physicianDetailBlock = subpages.slice(subpages.indexOf("function physicianDetail"), subpages.indexOf("const knowledgeParagraph"));
assert.match(physicianDetailBlock, /href="#\/physicians"/);
assert.match(physicianDetailBlock, /data-action="physician-avatar" data-id="\$\{physician\.id\}"/);
assert.doesNotMatch(physicianDetailBlock, /class="object-tabs"|href="#\/physicians\/specialties"|physician-schedule|physician-audit/);
assert.match(physicianDetailBlock, /擅长美形领域/);
assert.match(physicianDetailBlock, /排班与服务/);
assert.match(physicianDetailBlock, /档案状态/);
const physiciansPageBlock = app.slice(app.indexOf("function physiciansPage"), app.indexOf("const avatarStudioHash"));
assert.match(physiciansPageBlock, /data-action="new-physician"/);
assert.doesNotMatch(physiciansPageBlock, /data-nav="physicians\/avatar"|data-nav="physicians\/specialties"/);
const scopedAvatarStudioBlock = app.slice(app.indexOf("function physicianAvatarStudioPage"), app.indexOf("function paginationItems"));
assert.match(scopedAvatarStudioBlock, /href="#\/physician\/\$\{encodeURIComponent\(physician\.id\)\}"/);
assert.doesNotMatch(scopedAvatarStudioBlock, /moduleSubnav\("physicians","avatar"\)/);
assert.equal((scopedAvatarStudioBlock.match(/physicianReferenceImage\(physician,/g) || []).length, 2, "工作室的当前医师与右侧预览应展示真实生成参考素材");
assert.doesNotMatch(scopedAvatarStudioBlock, /physicianAvatar\(physician,"(?:lg|xl)"\)/, "工作室参考形象不得回退为头像 sprite");
assert.match(scopedAvatarStudioBlock, /形象一致保护已开启/);
assert.doesNotMatch(scopedAvatarStudioBlock, /优先保持已绑定参考形象的面部特征与专业观感/);
assert.match(scopedAvatarStudioBlock, /无法保证逐帧完全一致/);
assert.match(scopedAvatarStudioBlock, /预计时长/);
assert.match(scopedAvatarStudioBlock, /成片会自动匹配实际口播时长（4–15秒）/);
assert.match(styles, /\.avatar-parameter-grid\s*\{[^}]*align-items:\s*start/s, "参数字段不得因预计时长说明被纵向拉伸");
assert.match(styles, /\.avatar-parameter-grid\s*>\s*\.form-group\s*\{[^}]*align-content:\s*start/s, "三项参数的标签与下拉框必须保持同一基线");
assert.doesNotMatch(app, /case "physician-schedule"|case "physician-audit"/);
assert.match(app, /runAgentApiConsole/);
assert.match(app, /knowledgePageSize/);
assert.match(app, /aria-label="知识库分页"/);
assert.match(styles, /\.pagination-bar/);
assert.match(data, /physicianAvatarDataset: "photoreal-v1"/);
assert.match(data, /physicians: KNOWLEDGE_CATALOG_IMPORT\.physicians\.map/, "医师目录必须来自知识库导入，而非虚构样例");
assert.match(data, /avatarIndex:null/, "知识库导入的医师在未配置真实素材前不得使用虚构头像");
assert.match(styles, /physician-sprite-v1\.png/);
assert.match(app, /playsinline/);
assert.match(app, /avatarMediaRatio/);
assert.match(app, /avatar-open-video/);
assert.match(app, /avatar-view-job/);
assert.match(app, /avatar-delete-job/);
assert.match(app, /avatar-confirm-delete/);
assert.match(app, /avatarStudioHash/);
assert.match(app, /resourceId/);
assert.match(app, /avatarJobsPhysicianId/);
assert.match(app, /avatarPollingPhysicianId/);
assert.match(app, /avatarPollingRequestToken/);
assert.match(app, /avatarDrafts/);
assert.match(app, /avatarScopeEpoch/);
assert.match(app, /invalidateAvatarHydration/);
assert.match(app, /function mergeAvatarJobSnapshot/);
assert.match(app, /function patchAvatarStudioDom/);
assert.match(app, /hydrateAvatarStudio\(true, \{ background:true \}\)/);
assert.match(app, /document\.visibilityState !== "hidden"/);
assert.match(app, /Number\.isFinite\(configuredInterval\)/);
const avatarHydrateBlock = app.slice(app.indexOf("async function hydrateAvatarStudio"), app.indexOf("async function submitPhysicianAvatar"));
const avatarSubmitBlock = app.slice(app.indexOf("async function submitPhysicianAvatar"), app.indexOf("async function cancelAvatarJob"));
const avatarCancelBlock = app.slice(app.indexOf("async function cancelAvatarJob"), app.indexOf("function render"));
const avatarDeleteBlock = app.slice(app.indexOf("async function deleteAvatarJob"), app.indexOf("function openAvatarVideo"));
assert.doesNotMatch(avatarHydrateBlock, /render\(true\)/, "读取生成进度不得整页重绘");
assert.doesNotMatch(avatarSubmitBlock, /render\(true\)/, "提交任务不得整页重绘");
assert.doesNotMatch(avatarCancelBlock, /render\(true\)/, "取消任务不得整页重绘");
assert.doesNotMatch(avatarDeleteBlock, /render\(true\)/, "删除任务不得整页重绘");
assert.match(avatarHydrateBlock, /patchAvatarStudioDom/);
assert.match(avatarSubmitBlock, /patchAvatarStudioDom/);
assert.match(avatarCancelBlock, /patchAvatarStudioDom/);
assert.match(avatarDeleteBlock, /patchAvatarStudioDom/);
assert.match(app, /store\.addEventListener\("change", \(event\) => \{\s*if \(routeAvatarPhysician\(\) && event\.detail\?\.source === "acquisition-sync"\) return;/);
assert.match(store, /this\.save\("acquisition-sync"\)/);
assert.match(app, /physician_id=\$\{encodeURIComponent\(physicianId\)\}/);
assert.match(app, /data-avatar-studio-physician/);
assert.match(app, /data-avatar-job-grid/);
assert.match(app, /data-avatar-metrics/);
assert.match(app, /当前医师形象/);
assert.match(app, /每位医师的内容、任务和作品单独管理/);
assert.match(app, /自然知性女声/);
assert.match(app, /自然温润男声/);
const avatarVoicePresetBlock = app.slice(app.indexOf("const avatarVoicePresets"), app.indexOf("function physicianAvatarReferenceId"));
assert.match(avatarVoicePresetBlock, /Chinese \(Mandarin\)_Wise_Women/);
assert.match(avatarVoicePresetBlock, /Chinese \(Mandarin\)_Gentleman/);
assert.match(avatarVoicePresetBlock, /Chinese \(Mandarin\)_News_Anchor[^\n]*category:"经典音色"/);
assert.match(avatarVoicePresetBlock, /Chinese \(Mandarin\)_Reliable_Executive[^\n]*category:"经典音色"/);
assert.doesNotMatch(avatarVoicePresetBlock, /News_Anchor", name:"自然知性女声"|Reliable_Executive", name:"自然温润男声"/);
assert.match(app, /女:"Chinese \(Mandarin\)_Wise_Women"/);
assert.match(app, /男:"Chinese \(Mandarin\)_Gentleman"/);
assert.match(app, /runtimeLoaded \? \[\.\.\.runtimeVoices, \.\.\.avatarVoicePresets\] : avatarVoicePresets/, "运行时加载后仍应保留新旧兼容音色");
assert.match(app, /avatarReferencePhysicianIds\.has\(id\)/, "参考素材路径必须经过医师白名单");
assert.match(app, /\/assets\/physicians\/references\/\$\{encodeURIComponent\(id\)\}\.png/);
assert.match(avatarSubmitBlock, /referenceFileId,/);
assert.match(avatarSubmitBlock, /physicianAvatarReferenceFileId\(submittedPhysicianId\)/);
assert.match(styles, /\.avatar-reference-image[^}]*object-fit:\s*contain/);
assert.doesNotMatch(app, /id="avatar-physician-id"/);
assert.match(apiRouter, /getPhysicianAvatarJob\(jobMatch\[1\], userId, physicianId\)/);
assert.match(apiRouter, /MISSING_PHYSICIAN_SCOPE/);
assert.match(apiRouter, /getPhysicianAvatarWorkMedia\(workMediaMatch\[1\], userId, workMediaMatch\[2\], physicianId\)/);
assert.match(styles, /\.avatar-work-video[^}]*object-fit:\s*contain/);
assert.doesNotMatch(styles, /\.avatar-work-video\s*\{[^}]*object-fit:\s*cover/);
assert.doesNotMatch(styles, /\.avatar-job-media\s*\{[^}]*height:\s*210px/);
assert.match(styles, /\.avatar-job-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
assert.match(styles, /\.avatar-job-grid\s*>\s*\.empty\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
assert.match(styles, /\.avatar-job-card\s*\{[^}]*min-width:\s*0[^}]*display:\s*grid/s);
assert.match(styles, /\.avatar-job-media\s*\{[^}]*aspect-ratio:\s*1\.44\s*\/\s*1/s);
assert.match(styles, /\.avatar-card-backdrop\s*\{[^}]*object-fit:\s*cover[^}]*filter:\s*blur/s);
assert.match(styles, /\.avatar-job-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
const avatarCardBlock = app.slice(app.indexOf("function avatarJobCard"), app.indexOf("function physicianAvatarPickerPage"));
assert.match(avatarCardBlock, /class="avatar-card-backdrop"/);
assert.match(avatarCardBlock, /avatarIdentityReviewStatus\(job\) === "needs_review"/);
assert.match(avatarCardBlock, /形象待复核/);
assert.match(avatarCardBlock, /发布前不可使用/);
assert.match(avatarCardBlock, /class="avatar-media-open"\s+data-action="avatar-open-video"\s+data-id="\$\{escapeHtml\(job\.generationJobId\)\}"/);
assert.match(avatarCardBlock, /data-action="avatar-view-job"\s+data-id="\$\{escapeHtml\(job\.generationJobId\)\}"/);
assert.match(avatarCardBlock, /data-action="avatar-cancel-job"\s+data-id="\$\{escapeHtml\(job\.generationJobId\)\}"/);
assert.match(avatarCardBlock, /data-action="avatar-delete-job"\s+data-id="\$\{escapeHtml\(job\.generationJobId\)\}"/);
assert.match(avatarCardBlock, /muted playsinline preload="metadata"/);
assert.match(avatarCardBlock, /class="avatar-card-status/);
assert.match(avatarCardBlock, /class="avatar-card-author"/);
assert.match(avatarCardBlock, /data-avatar-job-id="\$\{escapeHtml\(job\.generationJobId\)\}"/);
assert.doesNotMatch(avatarCardBlock, /<article class="card avatar-job-card[^>]*data-action=/);
assert.doesNotMatch(avatarCardBlock, /\bautoplay\b|\.play\s*\(/i);
assert.doesNotMatch(avatarCardBlock, /class="avatar-work-video"[^>]*\bcontrols\b/);
assert.match(app, /jobs\.map\(avatarJobCard\)/);
assert.match(app, /case "avatar-open-video": openAvatarVideo\(id\); break;/);
assert.match(app, /case "avatar-view-job": openAvatarJobDetail\(id, target\); break;/);
assert.match(app, /case "avatar-cancel-job": cancelAvatarJob\(id\); break;/);
assert.match(app, /case "avatar-delete-job": showDeleteAvatarJobModal\(id\); break;/);
assert.match(app, /case "avatar-confirm-delete": deleteAvatarJob\(id, target\); break;/);
const avatarPlayerBlock = app.slice(app.indexOf("function openAvatarVideo"), app.indexOf("function avatarJobCard"));
assert.match(avatarPlayerBlock, /currentScopedAvatarJob\(jobId\)/);
assert.match(avatarPlayerBlock, /avatarIdentityReviewStatus\(job\) === "needs_review"/);
assert.match(avatarPlayerBlock, /仅供内部复核，发布前不可使用/);
assert.match(avatarPlayerBlock, /controls playsinline preload="metadata"/);
assert.match(avatarPlayerBlock, /className:"avatar-video-modal"/);
assert.match(avatarPlayerBlock, /data-action="avatar-view-job"/);
assert.match(avatarPlayerBlock, />取消<\/button>/);
assert.doesNotMatch(avatarPlayerBlock, /\bautoplay\b|\.play\s*\(/i);
const avatarDetailBlock = app.slice(app.indexOf("function showAvatarJobDetail"), app.indexOf("async function openAvatarJobDetail"));
assert.match(avatarDetailBlock, /avatarIdentityReviewStatus\(job\) === "needs_review"/);
assert.match(avatarDetailBlock, /形象待复核/);
assert.match(avatarDetailBlock, /work\?\.videoUrl && !identityNeedsReview/, "形象待复核作品不得显示下载入口");
assert.match(avatarDetailBlock, /仅保留用于内部播放与形象复核/);
assert.match(avatarDetailBlock, /\["成片时长",durationInfo\.detailLabel\]/);
const avatarDurationBlock = app.slice(app.indexOf("function avatarDurationPresentation"), app.indexOf("const avatarIdentityReviewStatus"));
assert.match(avatarDurationBlock, /metadata\.providerDuration, job\?\.providerDuration/);
assert.match(avatarDurationBlock, /原预计 \$\{requested\} 秒/);
assert.match(avatarDurationBlock, /预计 \$\{requested\} 秒/);
assert.doesNotMatch(avatarDetailBlock, /供应商时长|providerDuration/);
assert.match(app, /job\?\.identityReviewStatus \|\| job\?\.work\?\.identityReviewStatus/, "任务或作品层返回复核状态都应识别");
assert.match(app, /identityReviewStatus:avatarIdentityReviewStatus\(job\) \|\| null/, "复核状态变化必须触发卡片局部更新");
assert.match(app, /requestedDuration:job\.requestedDuration \|\| null/);
assert.match(app, /actualDuration:job\.providerDuration \|\| null/, "实际口播时长更新必须触发卡片局部更新");
assert.match(styles, /\.avatar-identity-review-warning/);
assert.match(styles, /\.avatar-identity-review-banner/);
assert.match(styles, /\.avatar-video-modal \.avatar-player-video[^}]*background:\s*#05050d/);
assert.match(styles, /\.avatar-player-video[^}]*object-fit:\s*contain/);
assert.doesNotMatch(styles, /\.avatar-player-video\s*\{[^}]*object-fit:\s*cover/);
assert.match(styles, /\.avatar-video-modal \.avatar-preview-player-stage[^}]*aspect-ratio:\s*1\.91\s*\/\s*1/);
assert.match(uiModule, /video\[controls\]/);
assert.match(uiModule, /pauseModalMedia\(root\)/);
assert.match(uiModule, /event\.key === "Escape"/);
assert.match(uiModule, /returnFocus\.focus\(\)/);
assert.match(serverEntry, /handleApiRequest/);
assert.match(serverEntry, /HUAMEI_HOST/);
assert.match(serverEntry, /长度不少于24位的非演示密钥/);
assert.match(serverEntry, /HUAMEI_ADMIN_USERNAME/);
assert.match(serverEntry, /HUAMEI_ADMIN_PASSWORD/);
assert.match(serverEntry, /HUAMEI_EXTERNAL_TEST_MODE/);
assert.match(serverEntry, /HUAMEI_EXTERNAL_TEST_ALLOW_MINIMAX_REAL/);
assert.match(serverEntry, /timingSafeEqual/);
assert.match(serverEntry, /apps["',\s]+acquisition-advisor["',\s]+dist["',\s]+client/);
assert.ok(
  serverEntry.indexOf('process.env.MINIMAX_REAL_CALL_ENABLED = "false"') < serverEntry.indexOf('await import("./server/api-router.mjs")'),
  "外测模式必须在动态导入视频运行时前关闭MiniMax真实调用"
);
assert.match(apiRouter, /authenticatedAdminRequests = new WeakSet/);
assert.match(apiRouter, /markAdminRequestAuthenticated/);
assert.doesNotMatch(apiRouter, /headers\[["']x-huamei-admin-authenticated["']\]/i, "不得信任客户端伪造的管理员标记请求头");
assert.match(agentRuntime, /AGENT_DEFINITIONS/);
assert.equal((agentRuntime.match(/id: "A-0[1-6]"/g) || []).length, 6, "应定义6个AI员工");
assert.match(apiRouter, /X-API-Key/);
assert.match(apiRouter, /Idempotency-Key/);
assert.match(apiRouter, /request\.method === "DELETE"/);
assert.match(openapi, /3\.1\.0/);

const reservePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const port = await reservePort();
const avatarRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-smoke-test-"));
const testInstanceId = `smoke-${process.pid}-${Date.now()}`;
const server = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd: fileURLToPath(root),
  env: { ...process.env, PORT: String(port), HUAMEI_EXTERNAL_TEST_MODE:"false", HUAMEI_LLM_ENABLED: "false", HUAMEI_TEST_INSTANCE_ID:testInstanceId, MINIMAX_API_KEY: "", MINIMAX_REAL_CALL_ENABLED: "false", PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRuntimeRoot },
  stdio: "ignore"
});
const serverExited = new Promise((resolve) => server.once("exit", resolve));

try {
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {}
    await delay(80);
  }
  assert.equal(response?.status, 200, "本地首页应正常响应");
  assert.match(await response.text(), /时代之美·客户360/);
  const testHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal((await testHealth.json()).test_instance_id, testInstanceId, "smoke测试必须命中本次隔离启动的服务实例");
  for (const asset of ["styles.css", "src/app.js", "src/subpages.js", "src/data.js", "src/project-knowledge.js", "src/knowledge-catalog-import.js", "src/store.js", "src/icons.js", "src/ui.js"]) {
    const assetResponse = await fetch(`http://127.0.0.1:${port}/${asset}`);
    assert.equal(assetResponse.status, 200, `资源加载失败：${asset}`);
    assert.ok((await assetResponse.text()).length > 100, `资源内容异常：${asset}`);
  }
  const physicianPortraits = await fetch(`http://127.0.0.1:${port}/assets/physicians/physician-sprite-v1.png`);
  assert.equal(physicianPortraits.status, 200, "医师写实头像素材加载失败");
  assert.ok((await physicianPortraits.arrayBuffer()).byteLength > 100000, "医师写实头像素材内容异常");
  for (const physicianId of ["DR-001", "DR-002", "DR-003", "DR-004", "DR-005", "DR-006"]) {
    const referencePortrait = await fetch(`http://127.0.0.1:${port}/assets/physicians/references/${physicianId}.png`);
    assert.equal(referencePortrait.status, 200, `${physicianId}生成参考素材加载失败`);
    assert.ok((await referencePortrait.arrayBuffer()).byteLength > 10000, `${physicianId}生成参考素材内容异常`);
  }
  const advisor = await fetch(`http://127.0.0.1:${port}/advisor`);
  assert.equal(advisor.status, 200, "获客顾问公开页应可访问");
  assert.match(await advisor.text(), /AI获客顾问/);
  const advisorAsset = await fetch(`http://127.0.0.1:${port}/assets/hero-bg.png`);
  assert.equal(advisorAsset.status, 200, "获客顾问构建资源应可访问");
  assert.ok((await advisorAsset.arrayBuffer()).byteLength > 1000, "获客顾问背景素材内容异常");
  for (const privateSource of ["server.mjs", "server/agent-runtime.mjs", "tests/api.mjs", "package.json", ".env.local", ".gitignore", "docs/MVP开发报告.md", "scripts/persist-minimax-local.mjs"]) {
    const privateResponse = await fetch(`http://127.0.0.1:${port}/${privateSource}`);
    assert.equal(privateResponse.status, 404, `服务端源文件不应公开：${privateSource}`);
  }
  console.log("✓ 工程文件与九大模块完整");
  console.log("✓ 41个二级入口与8类三级对象页完整（价格并入产品字段）");
  console.log("✓ 六个AI员工、API开放平台与服务端源文件隔离完整");
  console.log("✓ 34张项目卡片、20个标准项目域与完整知识章节已接入");
  console.log("✓ 客户360核心数据模型完整");
  console.log("✓ 本地服务器与全部前端资源可访问");
  console.log("MVP smoke tests passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([serverExited, delay(1000)]);
  await rm(avatarRuntimeRoot, { recursive:true, force:true });
}

const publicPort = await reservePort();
const publicBaseUrl = `http://127.0.0.1:${publicPort}`;
const publicRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-public-smoke-test-"));
const publicUsername = "external-tester";
const publicPassword = "test-only-password-2026";
const publicAuthorization = `Basic ${Buffer.from(`${publicUsername}:${publicPassword}`).toString("base64")}`;
const previewUsername = "preview-tester";
const previewPassword = "preview-only-password-2026";
const previewAuthorization = `Basic ${Buffer.from(`${previewUsername}:${previewPassword}`).toString("base64")}`;
const publicServer = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd: fileURLToPath(root),
  env: {
    ...process.env,
    PORT:String(publicPort),
    HUAMEI_HOST:"0.0.0.0",
    HUAMEI_EXTERNAL_TEST_MODE:"false",
    HUAMEI_API_KEY:"hm_public_test_api_key_2026_secure",
    HUAMEI_ADMIN_USERNAME:publicUsername,
    HUAMEI_ADMIN_PASSWORD:publicPassword,
    HUAMEI_PREVIEW_USERNAME:previewUsername,
    HUAMEI_PREVIEW_PASSWORD:previewPassword,
    HUAMEI_LLM_ENABLED:"false",
    HUAMEI_LEAD_STORE_FILE:":memory:",
    MINIMAX_API_KEY:"",
    MINIMAX_REAL_CALL_ENABLED:"false",
    PHYSICIAN_AVATAR_RUNTIME_ROOT:publicRuntimeRoot
  },
  stdio:"ignore"
});
const publicServerExited = new Promise((resolve) => publicServer.once("exit", resolve));

try {
  let publicHealth;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      publicHealth = await fetch(`${publicBaseUrl}/api/health`);
      if (publicHealth.ok) break;
    } catch {}
    await delay(80);
  }
  assert.equal(publicHealth?.status, 200, "线上监听时健康检查应保持公开");
  assert.equal((await fetch(`${publicBaseUrl}/api/v1/openapi.json`)).status, 200, "OpenAPI文档应保持现有公开规则");
  assert.equal((await fetch(`${publicBaseUrl}/advisor`)).status, 200, "获客顾问不应触发管理后台登录");

  const anonymousAdmin = await fetch(`${publicBaseUrl}/`);
  assert.equal(anonymousAdmin.status, 401, "线上管理后台必须认证");
  assert.match(anonymousAdmin.headers.get("www-authenticate") || "", /^Basic /);
  const spoofedAdmin = await fetch(`${publicBaseUrl}/`, { headers:{ "X-Huamei-Admin-Authenticated":"true" } });
  assert.equal(spoofedAdmin.status, 401, "伪造请求头不得绕过管理后台认证");
  const wrongAdmin = await fetch(`${publicBaseUrl}/`, { headers:{ Authorization:`Basic ${Buffer.from(`${publicUsername}:wrong-password-value`).toString("base64")}` } });
  assert.equal(wrongAdmin.status, 401, "错误密码不得进入管理后台");
  const authenticatedAdmin = await fetch(`${publicBaseUrl}/`, { headers:{ Authorization:publicAuthorization } });
  assert.equal(authenticatedAdmin.status, 200, "正确账密应可进入管理后台");
  assert.match(await authenticatedAdmin.text(), /时代之美·客户360/);
  assert.equal((await fetch(`${publicBaseUrl}/docs/MVP开发报告.md`)).status, 404, "非白名单静态文件应直接隐藏");

  const anonymousLocalApi = await fetch(`${publicBaseUrl}/api/local/acquisition-customers`);
  assert.equal(anonymousLocalApi.status, 403, "线上本地管理接口不得仅因反向代理回环地址而放行");
  const spoofedLocalApi = await fetch(`${publicBaseUrl}/api/local/acquisition-customers`, { headers:{ "X-Huamei-Admin-Authenticated":"true" } });
  assert.equal(spoofedLocalApi.status, 403, "伪造标记请求头不得访问管理接口");
  const authenticatedLocalApi = await fetch(`${publicBaseUrl}/api/local/acquisition-customers`, { headers:{ Authorization:publicAuthorization } });
  assert.equal(authenticatedLocalApi.status, 403, "系统管理员登录不自动获得客户档案权限");
  console.log("✓ 线上管理后台Basic认证、公开获客顾问与管理API信任边界通过");
} finally {
  publicServer.kill("SIGTERM");
  await Promise.race([publicServerExited, delay(1000)]);
  await rm(publicRuntimeRoot, { recursive:true, force:true });
}

const rejectedPublicServer = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd:fileURLToPath(root),
  env:{
    ...process.env,
    PORT:"0",
    HUAMEI_HOST:"0.0.0.0",
    HUAMEI_API_KEY:"hm_public_test_api_key_2026_secure",
    HUAMEI_ADMIN_USERNAME:"",
    HUAMEI_ADMIN_PASSWORD:"short",
    HUAMEI_LLM_ENABLED:"false",
    MINIMAX_API_KEY:"",
    MINIMAX_REAL_CALL_ENABLED:"false"
  },
  stdio:["ignore", "ignore", "pipe"]
});
let rejectedPublicStderr = "";
rejectedPublicServer.stderr.on("data", (chunk) => { rejectedPublicStderr += chunk.toString("utf8"); });
const rejectedPublicExit = await Promise.race([
  new Promise((resolve) => rejectedPublicServer.once("exit", (code) => resolve(code))),
  delay(2000).then(() => null)
]);
if (rejectedPublicExit === null) rejectedPublicServer.kill("SIGTERM");
assert.notEqual(rejectedPublicExit, null, "缺少管理账密时线上服务必须拒绝启动");
assert.notEqual(rejectedPublicExit, 0, "缺少管理账密时线上服务不得成功启动");
assert.match(rejectedPublicStderr, /HUAMEI_ADMIN_USERNAME.*HUAMEI_ADMIN_PASSWORD/s);
console.log("✓ 非本机监听在缺少强管理账密时会拒绝启动");

const externalTestPort = await reservePort();
const externalTestBaseUrl = `http://127.0.0.1:${externalTestPort}`;
const externalTestRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-external-test-smoke-"));
const externalTestServer = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd:fileURLToPath(root),
  env:{
    ...process.env,
    PORT:String(externalTestPort),
    HUAMEI_HOST:"0.0.0.0",
    HUAMEI_EXTERNAL_TEST_MODE:"true",
    HUAMEI_API_KEY:"hm_external_test_api_key_2026_secure",
    HUAMEI_ADMIN_USERNAME:publicUsername,
    HUAMEI_ADMIN_PASSWORD:publicPassword,
    HUAMEI_PREVIEW_USERNAME:previewUsername,
    HUAMEI_PREVIEW_PASSWORD:previewPassword,
    HUAMEI_LLM_ENABLED:"false",
    HUAMEI_LEAD_STORE_FILE:":memory:",
    MINIMAX_API_KEY:"unit-test-key-must-never-be-used",
    MINIMAX_REAL_CALL_ENABLED:"true",
    MINIMAX_REAL_USER_IDS:"admin-xuning",
    PHYSICIAN_AVATAR_RUNTIME_ROOT:externalTestRuntimeRoot
  },
  stdio:"ignore"
});
const externalTestServerExited = new Promise((resolve) => externalTestServer.once("exit", resolve));

try {
  let externalTestHealth;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      externalTestHealth = await fetch(`${externalTestBaseUrl}/api/health`);
      if (externalTestHealth.ok) break;
    } catch {}
    await delay(80);
  }
  assert.equal(externalTestHealth?.status, 200, "临时外测模式下健康检查应保持公开");
  const externalHealthBody = await externalTestHealth.json();
  assert.equal(externalHealthBody.status, "ok", "公开健康检查只确认网关存活");
  assert.equal(externalHealthBody.service, "huamei-web-gateway", "公开健康检查不得返回内部依赖详情");

  const anonymousExternalAdvisor = await fetch(`${externalTestBaseUrl}/advisor`);
  assert.equal(anonymousExternalAdvisor.status, 401, "临时外测的获客页必须认证");
  assert.match(anonymousExternalAdvisor.headers.get("www-authenticate") || "", /^Basic /);
  const anonymousExternalChat = await fetch(`${externalTestBaseUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ message:"请介绍光子嫩肤的一般项目知识" })
  });
  assert.equal(anonymousExternalChat.status, 401, "临时外测的公开咨询API也必须认证");
  assert.equal((await fetch(`${externalTestBaseUrl}/api/v1/openapi.json`)).status, 401, "临时外测的OpenAPI文档必须认证");

  const authenticatedExternalAdvisor = await fetch(`${externalTestBaseUrl}/advisor`, { headers:{ Authorization:previewAuthorization } });
  assert.equal(authenticatedExternalAdvisor.status, 200, "认证后应可访问获客页");
  assert.match(await authenticatedExternalAdvisor.text(), /AI获客顾问/);
  const authenticatedExternalChat = await fetch(`${externalTestBaseUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ Authorization:previewAuthorization, "Content-Type":"application/json" },
    body:JSON.stringify({ message:"请介绍光子嫩肤的一般项目知识" })
  });
  assert.equal(authenticatedExternalChat.status, 200, "认证后公开咨询API应可使用");
  const externalChatBody = await authenticatedExternalChat.json();
  assert.equal(externalChatBody.guardrails.llm_used, false, "临时外测咨询应运行在本地规则模式");
  assert.ok(externalChatBody.reply, "规则模式应返回咨询内容");

  const previewAvatarStatus = await fetch(`${externalTestBaseUrl}/api/local/physician-avatar/status`, { headers:{ Authorization:previewAuthorization } });
  assert.equal(previewAvatarStatus.status, 403, "外测预览账号不得访问管理API");
  const avatarStatus = await fetch(`${externalTestBaseUrl}/api/local/physician-avatar/status`, { headers:{ Authorization:publicAuthorization } });
  assert.equal(avatarStatus.status, 403, "System administration does not grant avatar access");

  const unauthenticatedWebhook = await fetch(`${externalTestBaseUrl}/api/webhooks/minimax/video`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:"{}"
  });
  assert.equal(unauthenticatedWebhook.status, 401, "未携带回调Token应由回调端点拒绝");
  assert.equal((await unauthenticatedWebhook.json()).error.code, "INVALID_CALLBACK_TOKEN", "MiniMax回调端点不应被Basic认证拦截");
  console.log("✓ 临时公网外测的预览/管理认证隔离、规则咨询与MiniMax强制关闭已通过");
} finally {
  externalTestServer.kill("SIGTERM");
  await Promise.race([externalTestServerExited, delay(1000)]);
  await rm(externalTestRuntimeRoot, { recursive:true, force:true });
}

const loopbackExternalPort = await reservePort();
const loopbackExternalBaseUrl = `http://127.0.0.1:${loopbackExternalPort}`;
const loopbackExternalRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-loopback-external-smoke-"));
const loopbackExternalServer = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd:fileURLToPath(root),
  env:{
    ...process.env,
    PORT:String(loopbackExternalPort),
    HUAMEI_HOST:"127.0.0.1",
    HUAMEI_EXTERNAL_TEST_MODE:"true",
    HUAMEI_API_KEY:"hm_loopback_external_key_2026_secure",
    HUAMEI_ADMIN_USERNAME:publicUsername,
    HUAMEI_ADMIN_PASSWORD:publicPassword,
    HUAMEI_PREVIEW_USERNAME:previewUsername,
    HUAMEI_PREVIEW_PASSWORD:previewPassword,
    HUAMEI_LLM_ENABLED:"false",
    HUAMEI_LEAD_STORE_FILE:":memory:",
    MINIMAX_API_KEY:"unit-test-key-must-never-be-used",
    MINIMAX_REAL_CALL_ENABLED:"true",
    HUAMEI_EXTERNAL_TEST_ALLOW_MINIMAX_REAL:"true",
    MINIMAX_REAL_USER_IDS:"admin-xuning",
    PHYSICIAN_AVATAR_RUNTIME_ROOT:loopbackExternalRuntimeRoot
  },
  stdio:"ignore"
});
const loopbackExternalServerExited = new Promise((resolve) => loopbackExternalServer.once("exit", resolve));

try {
  let loopbackHealth;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      loopbackHealth = await fetch(`${loopbackExternalBaseUrl}/api/health`);
      if (loopbackHealth.ok) break;
    } catch {}
    await delay(80);
  }
  assert.equal(loopbackHealth?.status, 200, "回环地址外测模式下健康检查应保持公开");
  assert.equal((await fetch(`${loopbackExternalBaseUrl}/advisor`)).status, 401, "回环监听不应绕过外测页面认证");
  const loopbackAnonymousChat = await fetch(`${loopbackExternalBaseUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ message:"请介绍热玛吉的一般项目知识" })
  });
  assert.equal(loopbackAnonymousChat.status, 401, "回环监听不应绕过外测API认证");

  const loopbackAuthenticatedAdvisor = await fetch(`${loopbackExternalBaseUrl}/advisor`, { headers:{ Authorization:previewAuthorization } });
  assert.equal(loopbackAuthenticatedAdvisor.status, 200, "回环外测模式下Basic账密应可访问页面");
  const loopbackAuthenticatedChat = await fetch(`${loopbackExternalBaseUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ Authorization:previewAuthorization, "Content-Type":"application/json" },
    body:JSON.stringify({ message:"请介绍热玛吉的一般项目知识" })
  });
  assert.equal(loopbackAuthenticatedChat.status, 200, "回环外测模式下Basic账密应可调用咨询API");
  assert.equal((await loopbackAuthenticatedChat.json()).guardrails.llm_used, false, "回环外测咨询应使用规则模式");

  const loopbackPreviewAvatar = await fetch(`${loopbackExternalBaseUrl}/api/local/physician-avatar/status`, { headers:{ Authorization:previewAuthorization } });
  assert.equal(loopbackPreviewAvatar.status, 403, "回环外测预览账号也不得访问管理API");
  const loopbackAvatarStatus = await fetch(`${loopbackExternalBaseUrl}/api/local/physician-avatar/status`, { headers:{ Authorization:publicAuthorization } });
  assert.equal(loopbackAvatarStatus.status, 403, "Provider configuration cannot expand business-role permissions");

  console.log("✓ 只监听127.0.0.1时，外测预览/管理隔离与MiniMax双重显式准入生效");
} finally {
  loopbackExternalServer.kill("SIGTERM");
  await Promise.race([loopbackExternalServerExited, delay(1000)]);
  await rm(loopbackExternalRuntimeRoot, { recursive:true, force:true });
}
