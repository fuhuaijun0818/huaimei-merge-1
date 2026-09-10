import assert from "node:assert/strict";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, extname, join } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowPath = join(projectRoot, ".github", "workflows", "production-verification.yml");
const workflow = await readFile(workflowPath, "utf8");

assert.ok(!workflow.includes("\t"), "GitHub Actions YAML不得包含Tab缩进");
assert.ok(!workflow.split(/\r?\n/).some((line) => /\s+$/.test(line)), "GitHub Actions YAML不得包含行尾空白");

const ruby = spawnSync("ruby", [
  "-e",
  "require 'yaml'; YAML.parse_file(ARGV.fetch(0))",
  workflowPath
], { encoding:"utf8" });
assert.equal(ruby.error, undefined, "本地CI静态验证需要Ruby/Psych用于YAML语法解析");
assert.equal(ruby.status, 0, `YAML语法无效：${String(ruby.stderr || ruby.stdout).trim()}`);

for (const fragment of [
  "permissions:\n  contents: read",
  "policy-and-source-scan:",
  "static-and-node:",
  "python-tests:",
  "dependency-audit:",
  "container-builds:",
  "postgres-redis-integration:",
  "npm audit --omit=dev --audit-level=high",
  "npm run test:production-gates",
  "python -m pip check",
  "PYTHONPATH=graphrag-service python -m unittest discover -s graphrag-service/tests -v",
  "agent-orchestrator/.venv-ci/bin/python -m unittest discover -s agent-orchestrator/tests -v",
  "python -m py_compile graphrag-service/loadtest/load_500.py graphrag-service/loadtest/soak_multiturn.py",
  "python graphrag-service/loadtest/load_500.py --help",
  "python graphrag-service/loadtest/soak_multiturn.py --help",
  "npm run test:postgres:ci",
  "npm run test:postgres-role-provisioning",
  "npm run test:redis-live",
  "LITELLM_LOCAL_MODEL_COST_MAP: \"True\"",
  "Apply and replay all migrations including required 001-014",
  "HUAMEI_CI_NODE_BASE_IMAGE: ${{ vars.HUAMEI_CI_NODE_BASE_IMAGE }}",
  "HUAMEI_CI_PYTHON_BASE_IMAGE: ${{ vars.HUAMEI_CI_PYTHON_BASE_IMAGE }}",
  "HUAMEI_CI_POSTGRES_IMAGE: ${{ vars.HUAMEI_CI_POSTGRES_IMAGE }}",
  "HUAMEI_CI_REDIS_IMAGE: ${{ vars.HUAMEI_CI_REDIS_IMAGE }}",
  "--build-arg NODE_IMAGE=\"${HUAMEI_CI_NODE_BASE_IMAGE}\"",
  "--build-arg PYTHON_IMAGE=\"${HUAMEI_CI_PYTHON_BASE_IMAGE}\"",
  "org.opencontainers.image.revision",
  "SHOW server_version_num",
  "redis_version:7\\.",
  "docker build"
]) {
  assert.ok(workflow.includes(fragment), `CI流水线缺少门禁：${fragment}`);
}

assert.doesNotMatch(workflow, /pull_request_target\s*:/, "不允许在可执行PR代码的流水线使用pull_request_target");
assert.doesNotMatch(workflow, /continue-on-error:\s*true/, "生产验证门禁不得用continue-on-error绕过失败");
assert.doesNotMatch(workflow, /(?:set\s+-x|set\s+-o\s+xtrace)/, "CI不得打开shell命令展开，避免密钥进入日志");
assert.doesNotMatch(workflow, /curl[^\n|]*\|\s*(?:ba)?sh\b/i, "CI不得下载远程脚本后直接交给shell执行");
assert.doesNotMatch(workflow, /postgres(?:ql)?:\/\/[^\s:$]+:[^\s$@]+@/i, "CI YAML不得内置PostgreSQL密码");
assert.doesNotMatch(workflow, /redis:\/\/:[^\s$@]+@/i, "CI YAML不得内置Redis密码");
assert.doesNotMatch(workflow, /\b(?:postgres|redis):(?:latest|\d[^\s"']*)/i, "PostgreSQL/Redis CI镜像不得使用可变tag");
assert.match(workflow, /for secret in[^\n]*bootstrap_password[^\n]*migration_password[^\n]*runtime_password[^\n]*redis_password[^\n]*identity_pepper/, "所有临时密钥必须进入统一脱敏清单");
assert.ok(workflow.includes('echo "::add-mask::${secret}"'), "临时密钥在使用前必须加入GitHub日志脱敏");
const migrationReplayIndex = workflow.indexOf("Apply and replay all migrations including required 001-014");
const postMigrationAclIndex = workflow.indexOf("Reconcile exact runtime object ACLs after migrations");
const postgresSuiteIndex = workflow.indexOf("Verify migration, RLS, knowledge, sessions, Outbox, privacy, encryption and domain contracts");
assert.ok(migrationReplayIndex >= 0 && postMigrationAclIndex > migrationReplayIndex && postgresSuiteIndex > postMigrationAclIndex,
  "CI必须在迁移重放后重新归一对象ACL，再运行PostgreSQL集成门禁");

const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
assert.ok(actionReferences.length > 0, "CI流水线必须显式声明第三方Action");
for (const reference of actionReferences) {
  if (reference.startsWith("./")) continue;
  assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `第三方Action必须固定到40位commit SHA：${reference}`);
}
for (const actionName of ["actions/checkout", "actions/setup-node", "actions/setup-python"]) {
  assert.ok(actionReferences.some((reference) => reference.startsWith(`${actionName}@`)), `CI缺少固定SHA的${actionName}`);
}
const checkoutCount = actionReferences.filter((reference) => reference.startsWith("actions/checkout@")).length;
const nonPersistedCheckoutCount = (workflow.match(/persist-credentials:\s*false/g) || []).length;
assert.equal(nonPersistedCheckoutCount, checkoutCount, "每个checkout都必须设置persist-credentials:false");

const gitCandidates = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd:projectRoot,
  encoding:"buffer",
  maxBuffer:64 * 1024 * 1024
});
assert.equal(gitCandidates.error, undefined, "敏感文件扫描需要git读取候选文件清单");
assert.equal(gitCandidates.status, 0, `无法读取候选文件清单：${String(gitCandidates.stderr || "").trim()}`);
const candidateFiles = gitCandidates.stdout.toString("utf8").split("\0").filter(Boolean);
assert.ok(candidateFiles.length > 0, "敏感文件扫描候选清单为空");

const forbiddenFileNames = /^(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials\.json|service[-_]account\.json)$/i;
const forbiddenExtensions = new Set([".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"]);
const allowedEnvironmentExamples = new Set([".env.example", "env.example"]);
const sensitiveFileFindings = [];
for (const relativeFile of candidateFiles) {
  const fileName = basename(relativeFile);
  const lowerName = fileName.toLowerCase();
  if ((forbiddenFileNames.test(lowerName) && !allowedEnvironmentExamples.has(lowerName))
      || forbiddenExtensions.has(extname(lowerName))) {
    sensitiveFileFindings.push(relativeFile);
  }
}
assert.deepEqual(sensitiveFileFindings, [], `候选提交包含禁止的敏感文件名：${sensitiveFileFindings.join(", ")}`);

for (const ignoredSensitivePath of [
  ".env",
  ".env.local",
  "deploy/local/.env",
  "graphrag-service/graphrag_project/.env",
  ".local-data/acquisition-sessions.json"
]) {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", ignoredSensitivePath], { cwd:projectRoot });
  assert.equal(ignored.status, 0, `敏感运行文件必须被.gitignore排除：${ignoredSensitivePath}`);
}

const dockerIgnore = await readFile(join(projectRoot, ".dockerignore"), "utf8");
for (const ignoreRule of ["**/.env", "**/.env.*", "**/.local-data/", "**/.git/"]) {
  assert.ok(dockerIgnore.split(/\r?\n/).includes(ignoreRule), `.dockerignore缺少敏感构建上下文规则：${ignoreRule}`);
}

const validateDockerBaseArgument = async (dockerfilePath, argumentName) => {
  const dockerfile = await readFile(join(projectRoot, dockerfilePath), "utf8");
  assert.match(
    dockerfile,
    new RegExp(`^ARG ${argumentName}=[^\\s]+$`, "m"),
    `${dockerfilePath}必须声明可由CI注入的${argumentName}`
  );
  const fromLines = dockerfile.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^FROM\s+/i.test(line));
  assert.ok(fromLines.length > 0, `${dockerfilePath}必须包含FROM指令`);
  for (const fromLine of fromLines) {
    assert.match(
      fromLine,
      new RegExp(`^FROM \\$\\{${argumentName}\\}(?:\\s+AS\\s+[A-Za-z0-9_.-]+)?$`, "i"),
      `${dockerfilePath}的每个构建阶段都必须消费CI传入的${argumentName}：${fromLine}`
    );
  }
};
await validateDockerBaseArgument("Dockerfile", "NODE_IMAGE");
await validateDockerBaseArgument(join("graphrag-service", "Dockerfile"), "PYTHON_IMAGE");
await validateDockerBaseArgument(join("agent-orchestrator", "Dockerfile"), "PYTHON_IMAGE");

const textExtensions = new Set([
  ".cjs", ".conf", ".css", ".env", ".example", ".html", ".ini", ".js", ".json",
  ".jsonl", ".jsx", ".md", ".mjs", ".npmrc", ".properties", ".py", ".sh", ".sql",
  ".toml", ".txt", ".xml", ".yaml", ".yml"
]);
const textFileNames = new Set(["dockerfile", "caddyfile", ".dockerignore", ".gitignore"]);
const secretPatterns = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["slack_webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["stripe_live_key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ["openai_project_key", /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ["literal_npm_auth_token", /_authToken\s*=\s*(?!\$\{)[^\s#]+/i]
];
const secretFindings = [];
for (const relativeFile of candidateFiles) {
  const lowerName = basename(relativeFile).toLowerCase();
  if (!textExtensions.has(extname(lowerName)) && !textFileNames.has(lowerName)) continue;
  let fileStat;
  try { fileStat = await lstat(join(projectRoot, relativeFile)); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  if (!fileStat.isFile()) continue;
  const content = await readFile(join(projectRoot, relativeFile), "utf8");
  for (const [findingType, pattern] of secretPatterns) {
    if (pattern.test(content)) secretFindings.push(`${relativeFile}:${findingType}`);
  }
  if (!relativeFile.startsWith("tests/")) {
    const credentialUrlPattern = /(?:postgres(?:ql)?:\/\/[^/\s:@]+:|redis:\/\/:)([^${}<>\s@]+)@/gi;
    for (const match of content.matchAll(credentialUrlPattern)) {
      const candidatePassword = match[1];
      if (!/(?:replace[_-]?with|placeholder|not[_-]?printed|unit[_-]?test|do[_-]?not[_-]?leak|injected)/i.test(candidatePassword)) {
        secretFindings.push(`${relativeFile}:literal_credential_url`);
      }
    }
  }
}
assert.deepEqual(secretFindings, [], `候选提交疑似包含高置信度凭据：${secretFindings.join(", ")}`);

const expectedMigrations = [
  "001_initial_schema.sql",
  "002_production_governance.sql",
  "003_force_tenant_isolation.sql",
  "004_outbox_delivery.sql",
  "005_knowledge_release_workflow.sql",
  "006_conversation_idempotency.sql",
  "007_conversation_recovery.sql",
  "008_privacy_execution_controls.sql",
  "009_lead_candidate_isolation.sql",
  "010_privacy_identity_attestations.sql",
  "011_contact_vault.sql",
  "012_langgraph_turn_protocol.sql",
  "013_contact_manual_verification.sql",
  "014_appointment_registration.sql",
  "015_knowledge_intake_persistence.sql",
  "016_knowledge_publication_packages.sql",
  "017_management_accounts.sql"
];
await Promise.all(expectedMigrations.map((name) => access(join(projectRoot, "db", "migrations", name))));
const actualMigrations = (await readdir(join(projectRoot, "db", "migrations")))
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort();
assert.deepEqual(actualMigrations, expectedMigrations, "CI迁移清单必须与仓库001-014完整一致；新增迁移时同步更新门禁和文档");

const packageDocument = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
for (const scriptName of [
  "test:graphrag:ci", "test:load:soak", "test:postgres:ci", "test:redis-live",
  "test:postgres-role-provisioning", "test:formal-evidence", "test:production-gates",
  "test:langgraph-contract", "test:langgraph-python", "test:langgraph-live",
  "evidence:evaluation", "evidence:capacity", "ci:validate"
]) {
  assert.equal(typeof packageDocument.scripts?.[scriptName], "string", `package.json缺少${scriptName}`);
}
const postgresCiTests = [
  "tests/postgres-migration-integration.mjs",
  "tests/postgres-field-envelope-v2-migration-integration.mjs",
  "tests/postgres-rls-integration.mjs",
  "tests/postgres-knowledge-workflow-integration.mjs",
  "tests/postgres-session-consistency.mjs",
  "tests/postgres-langgraph-turn-protocol-integration.mjs",
  "tests/postgres-outbox-integration.mjs",
  "tests/postgres-domain-integration.mjs",
  "tests/postgres-lead-verification-integration.mjs",
  "tests/postgres-contact-vault-integration.mjs",
  "tests/postgres-privacy-rights-integration.mjs",
  "tests/acquisition-service-privacy-integration.mjs",
  "tests/postgres-privacy-attestation-integration.mjs",
  "tests/postgres-privacy-execution-integration.mjs",
  "tests/postgres-field-encryption-integration.mjs"
];
for (const testPath of postgresCiTests) {
  assert.ok(packageDocument.scripts["test:postgres:ci"].includes(testPath), `test:postgres:ci缺少${testPath}`);
}
assert.ok(packageDocument.scripts.test.includes("tests/langgraph-orchestrator-contract.mjs"), "npm test必须覆盖LangGraph Node契约测试");

for (const productionGate of [
  "test:observability", "test:resilience", "test:formal-evidence", "test:release-preflight", "test:deployment-release"
]) {
  assert.ok(packageDocument.scripts["test:production-gates"].includes(productionGate), `test:production-gates缺少${productionGate}`);
}

const validatePackageLock = async (directory) => {
  const packageJsonPath = join(projectRoot, directory, "package.json");
  const packageLockPath = join(projectRoot, directory, "package-lock.json");
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const lock = JSON.parse(await readFile(packageLockPath, "utf8"));
  assert.equal(lock.lockfileVersion, 3, `${packageLockPath}必须使用lockfileVersion 3`);
  const lockRoot = lock.packages?.[""];
  assert.ok(lockRoot, `${packageLockPath}缺少根packages记录`);
  assert.equal(lockRoot.name, manifest.name, `${packageLockPath}项目名与package.json不一致`);
  assert.equal(lockRoot.version, manifest.version, `${packageLockPath}版本与package.json不一致`);
  for (const dependencyField of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(lockRoot[dependencyField] || {}, manifest[dependencyField] || {}, `${packageLockPath}的${dependencyField}与package.json不一致`);
  }
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath || metadata.link) continue;
    assert.match(String(metadata.integrity || ""), /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${packageLockPath}:${packagePath}缺少sha512完整性摘要`);
    if (metadata.resolved) {
      let resolvedUrl;
      try {
        resolvedUrl = new URL(metadata.resolved);
      } catch {
        assert.fail(`${packageLockPath}:${packagePath}的resolved不是合法URL：${metadata.resolved}`);
      }
      assert.equal(resolvedUrl.protocol, "https:", `${packageLockPath}:${packagePath}的resolved必须使用HTTPS`);
      assert.ok(
        new Set(["https://registry.npmjs.org", "https://registry.npmmirror.com"]).has(resolvedUrl.origin),
        `${packageLockPath}:${packagePath}引用了未批准的npm下载源：${resolvedUrl.origin}`
      );
    }
  }
};
await validatePackageLock("");
await validatePackageLock(join("apps", "acquisition-advisor"));

const pythonRequirements = (await readFile(join(projectRoot, "graphrag-service", "requirements.txt"), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
assert.equal(new Set(pythonRequirements).size, pythonRequirements.length, "Python requirements不得重复");
for (const requirement of pythonRequirements) {
  assert.match(requirement, /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9][A-Za-z0-9_.+!-]*$/, `Python直接依赖必须精确固定版本：${requirement}`);
}

for (const testPath of [
  ...postgresCiTests,
  "tests/postgres-role-provisioning-integration.mjs",
  "tests/redis-live-integration.mjs",
  "tests/observability.mjs",
  "tests/observability-core-integration.mjs",
  "tests/conversation-recovery-worker-readiness.mjs",
  "tests/resilience-fault-injection.mjs",
  "tests/formal-evidence-executors.mjs",
  "tests/production-release-preflight.mjs",
  "tests/deployment-release-contract.mjs"
]) {
  const result = spawnSync(process.execPath, ["--check", join(projectRoot, testPath)], { encoding:"utf8" });
  assert.equal(result.status, 0, `${testPath}语法检查失败：${String(result.stderr || result.stdout).trim()}`);
}

console.log("✓ GitHub Actions固定SHA、敏感源扫描、锁文件、001-014迁移清单与CI脚本静态验证通过");
