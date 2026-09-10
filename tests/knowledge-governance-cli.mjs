import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKnowledgeGovernance } from "../scripts/knowledge-governance-cli.mjs";

const root = await mkdtemp(join(tmpdir(), "huamei-governance-"));
const secret = "governance-secret-0123456789-abcdefghijk";
const jwt = "header.payload.signature";
const releaseId = "krel_governance_test_1";
const requests = [];

const protectedFile = async (name, value) => {
  const path = join(root, name);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode:0o600 });
  return path;
};

try {
  const secretPath = await protectedFile("caller-secret", secret);
  const tokenPath = await protectedFile("release-manager.jwt", jwt);
  const draftPath = await protectedFile("draft.json", { package_checksum:"a".repeat(64), record_list_checksum:"b".repeat(64), index_version:"official-v1" });
  const reviewPaths = Object.fromEntries(await Promise.all(["business", "medical", "compliance"].map(async (reviewType) => [
    reviewType,
    await protectedFile(`${reviewType}.json`, { decision:"approved", scope_checksum:"c".repeat(64), comments:`${reviewType} approved` })
  ])));
  const indexPath = await protectedFile("index.json", { manifest_sha256:"d".repeat(64), index_version:"official-v1" });
  const env = {
    HUAMEI_RUNTIME_ENV:"production",
    HUAMEI_KNOWLEDGE_GOVERNANCE_URL:"http://127.0.0.1:4180",
    HUAMEI_KNOWLEDGE_GOVERNANCE_TENANT_ID:"huamei-shanghai",
    HUAMEI_KNOWLEDGE_GOVERNANCE_CALLER_ID:"huamei_knowledge_governance",
    HUAMEI_KNOWLEDGE_GOVERNANCE_CALLER_SECRET_FILE:secretPath,
    HUAMEI_KNOWLEDGE_GOVERNANCE_INPUT_ROOT:root
  };
  const state = { active:false, reviews:new Set(), indexed:false };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const request = { path:`${parsed.pathname}${parsed.search}`, method:options.method, headers:options.headers, body:options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    assert.equal(options.headers["X-Caller-Id"], "huamei_knowledge_governance");
    assert.equal(options.headers["X-Service-Key"], secret);
    assert.equal(options.headers["X-Tenant-Id"], "huamei-shanghai");
    if (parsed.pathname.endsWith("/admission")) {
      return Response.json({ status:state.active ? "active" : "blocked", active_release:state.active ? { id:releaseId } : null });
    }
    assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
    if (parsed.pathname.endsWith("/drafts")) return Response.json({ release:{ id:releaseId, status:"draft" } }, { status:201 });
    if (parsed.pathname.endsWith("/review-scope")) return Response.json({ release_id:releaseId, scope_checksum:"c".repeat(64) });
    const review = parsed.pathname.match(/\/reviews\/(business|medical|compliance)$/)?.[1];
    if (review) {
      state.reviews.add(review);
      return Response.json({ release_id:releaseId, review_type:review, decision:"approved" });
    }
    if (parsed.pathname.endsWith("/receipt")) {
      assert.deepEqual([...state.reviews].sort(), ["business", "compliance", "medical"]);
      return Response.json({ release_id:releaseId, receipt:{ scope_checksum:"c".repeat(64) } });
    }
    if (parsed.pathname.endsWith("/index")) {
      state.indexed = true;
      return Response.json({ release_id:releaseId, index_status:"bound" });
    }
    if (parsed.pathname.endsWith("/activate")) {
      assert.equal(state.indexed, true);
      state.active = true;
      return Response.json({ release_id:releaseId, status:"active" });
    }
    return Response.json({ error:{ code:"NOT_FOUND" } }, { status:404 });
  };
  const run = (argv) => runKnowledgeGovernance({ argv, env, fetchImpl });

  assert.equal((await run(["admission"])).response.status, "blocked");
  const draft = await run(["draft", `--payload-file=${draftPath}`, `--oidc-token-file=${tokenPath}`]);
  assert.equal(draft.response.release.id, releaseId);
  await run(["scope", `--release-id=${releaseId}`, `--oidc-token-file=${tokenPath}`]);
  for (const reviewType of ["business", "medical", "compliance"]) {
    await run(["review", `--release-id=${releaseId}`, `--review-type=${reviewType}`, `--payload-file=${reviewPaths[reviewType]}`, `--oidc-token-file=${tokenPath}`]);
  }
  await run(["receipt", `--release-id=${releaseId}`, `--oidc-token-file=${tokenPath}`]);
  await run(["index", `--release-id=${releaseId}`, `--payload-file=${indexPath}`, `--oidc-token-file=${tokenPath}`]);
  await run(["activate", `--release-id=${releaseId}`, `--oidc-token-file=${tokenPath}`]);
  assert.equal((await run(["admission"])).response.status, "active");
  assert.equal(requests.length, 10);
  assert.equal(JSON.stringify(await run(["admission"])).includes(secret), false, "CLI result must not echo caller secret");
  assert.equal(JSON.stringify(await run(["admission"])).includes(jwt), false, "CLI result must not echo OIDC token");

  const mismatchPath = await protectedFile("wrong-tenant.json", { tenant_id:"another-tenant" });
  const beforeMismatch = requests.length;
  await assert.rejects(
    run(["draft", `--payload-file=${mismatchPath}`, `--oidc-token-file=${tokenPath}`]),
    (error) => error.code === "KNOWLEDGE_GOVERNANCE_TENANT_MISMATCH"
  );
  assert.equal(requests.length, beforeMismatch, "tenant mismatch must be rejected before network access");

  await chmod(tokenPath, 0o644);
  await assert.rejects(
    run(["scope", `--release-id=${releaseId}`, `--oidc-token-file=${tokenPath}`]),
    (error) => error.code === "KNOWLEDGE_GOVERNANCE_INPUT_PERMISSIONS"
  );
  await chmod(tokenPath, 0o600);
  await chmod(root, 0o755);
  await assert.rejects(
    run(["admission"]),
    (error) => error.code === "KNOWLEDGE_GOVERNANCE_INPUT_ROOT_PERMISSIONS"
  );
  await chmod(root, 0o700);
  await assert.rejects(run(["delete-everything"]), (error) => error.code === "KNOWLEDGE_GOVERNANCE_COMMAND_INVALID");
  await assert.rejects(
    runKnowledgeGovernance({ argv:["admission"], env:{ ...env, HUAMEI_KNOWLEDGE_GOVERNANCE_URL:"http://example.com" }, fetchImpl }),
    (error) => error.code === "KNOWLEDGE_GOVERNANCE_URL_INSECURE"
  );
  await assert.rejects(
    runKnowledgeGovernance({ argv:["admission"], env:{ ...env, HUAMEI_KNOWLEDGE_GOVERNANCE_CALLER_SECRET_FILE:"/etc/hosts" }, fetchImpl }),
    (error) => error.code === "KNOWLEDGE_GOVERNANCE_INPUT_OUTSIDE_ROOT"
  );

  const remoteFailure = async () => Response.json({ error:{ code:"DENIED", message:`Bearer ${jwt} rejected` } }, { status:403 });
  await assert.rejects(
    runKnowledgeGovernance({ argv:["scope", `--release-id=${releaseId}`, `--oidc-token-file=${tokenPath}`], env, fetchImpl:remoteFailure }),
    (error) => error.code === "DENIED" && !error.message.includes(jwt) && error.message.includes("[REDACTED]")
  );
  console.log("✓ 首次知识治理CLI：固定租户、独立身份、受保护文件、三审发布链路与脱敏失败关闭通过");
} finally {
  await rm(root, { recursive:true, force:true });
}
