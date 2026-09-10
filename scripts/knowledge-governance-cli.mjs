import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["admission", "draft", "scope", "review", "receipt", "index", "activate"]);
const REVIEW_TYPES = new Set(["business", "medical", "compliance"]);
const MAX_SECRET_BYTES = 20_000;
const MAX_PAYLOAD_BYTES = 512_000;

const governanceError = (code, message, status = 1) => {
  const error = new Error(message);
  error.code = code;
  error.exitCode = status;
  return error;
};

const parseArguments = (argv = []) => {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_COMMAND_INVALID", `Command must be one of: ${[...COMMANDS].join(", ")}`);
  }
  const options = {};
  for (const argument of rest) {
    const match = String(argument).match(/^--([a-z][a-z0-9-]*)=(.+)$/i);
    if (!match) throw governanceError("KNOWLEDGE_GOVERNANCE_ARGUMENT_INVALID", "Arguments must use --name=value syntax");
    if (Object.hasOwn(options, match[1])) {
      throw governanceError("KNOWLEDGE_GOVERNANCE_ARGUMENT_DUPLICATE", `Argument --${match[1]} may be supplied only once`);
    }
    options[match[1]] = match[2];
  }
  return { command, options };
};

const readProtectedFile = async (path, { maxBytes = MAX_SECRET_BYTES, label, inputRoot }) => {
  if (!String(path || "").trim()) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_REQUIRED", `${label} file is required`);
  }
  const absolute = resolve(String(path || ""));
  if (inputRoot) {
    const requestedRoot = resolve(String(inputRoot));
    const rootMetadata = await lstat(requestedRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0) {
      throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_ROOT_PERMISSIONS", "Protected governance input root must be a non-symlink directory inaccessible to group and other users");
    }
    const root = await realpath(requestedRoot);
    const resolvedFile = await realpath(absolute);
    const relativePath = relative(root, resolvedFile);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes(sep)) {
      throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_OUTSIDE_ROOT", `${label} must be inside the protected governance input directory`);
    }
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_SYMLINK", `${label} must not be a symbolic link`);
  }
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_INVALID", `${label} must be a non-empty bounded regular file`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_PERMISSIONS", `${label} must not be accessible by group or other users`);
  }
  return readFile(absolute, "utf8");
};

const validateBaseUrl = (value) => {
  let parsed;
  try { parsed = new URL(String(value || "http://acquisition:4180")); }
  catch { throw governanceError("KNOWLEDGE_GOVERNANCE_URL_INVALID", "Governance service URL is invalid"); }
  const allowedHttpHost = ["acquisition", "127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && allowedHttpHost)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_URL_INSECURE", "Governance service must use HTTPS or the private acquisition service hostname");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_URL_INVALID", "Governance service URL cannot contain credentials, path, query or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
};

const releaseIdFor = (options) => {
  const value = String(options["release-id"] || "").trim();
  if (!/^krel_[A-Za-z0-9._:-]{1,120}$/.test(value)) {
    throw governanceError("KNOWLEDGE_RELEASE_ID_INVALID", "--release-id must identify one immutable knowledge release");
  }
  return value;
};

const operationFor = (command, options, tenantId) => {
  if (command === "admission") return { method:"GET", path:`/v1/knowledge/admission?tenant_id=${encodeURIComponent(tenantId)}`, needsIdentity:false };
  if (command === "draft") return { method:"POST", path:"/v1/knowledge/releases/drafts", needsPayload:true, needsIdentity:true };
  const releaseId = releaseIdFor(options);
  if (command === "scope") return { method:"GET", path:`/v1/knowledge/releases/${encodeURIComponent(releaseId)}/review-scope?tenant_id=${encodeURIComponent(tenantId)}`, needsIdentity:true };
  if (command === "receipt") return { method:"GET", path:`/v1/knowledge/releases/${encodeURIComponent(releaseId)}/receipt?tenant_id=${encodeURIComponent(tenantId)}`, needsIdentity:true };
  if (command === "review") {
    const reviewType = String(options["review-type"] || "").trim();
    if (!REVIEW_TYPES.has(reviewType)) throw governanceError("KNOWLEDGE_REVIEW_TYPE_INVALID", "--review-type must be business, medical or compliance");
    return { method:"POST", path:`/v1/knowledge/releases/${encodeURIComponent(releaseId)}/reviews/${reviewType}`, needsPayload:true, needsIdentity:true };
  }
  if (command === "index") return { method:"POST", path:`/v1/knowledge/releases/${encodeURIComponent(releaseId)}/index`, needsPayload:true, needsIdentity:true };
  return { method:"POST", path:`/v1/knowledge/releases/${encodeURIComponent(releaseId)}/activate`, body:{ tenant_id:tenantId }, needsIdentity:true };
};

const payloadFrom = async (path, tenantId, inputRoot) => {
  const raw = await readProtectedFile(path, { maxBytes:MAX_PAYLOAD_BYTES, label:"governance payload", inputRoot });
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw governanceError("KNOWLEDGE_GOVERNANCE_PAYLOAD_INVALID", "Governance payload must be valid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_PAYLOAD_INVALID", "Governance payload must be a JSON object");
  }
  const suppliedTenant = String(payload.tenant_id || "").trim();
  if (suppliedTenant && suppliedTenant !== tenantId) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_TENANT_MISMATCH", "Payload tenant does not match the fixed governance tenant");
  }
  return { ...payload, tenant_id:tenantId };
};

const safeRemoteError = (body, status) => {
  const code = String(body?.error?.code || `HTTP_${status}`).replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 120);
  const message = String(body?.error?.message || "Knowledge governance request failed")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
  return governanceError(code, message, 2);
};

export async function runKnowledgeGovernance(options = {}) {
  const env = options.env || process.env;
  const { command, options:args } = parseArguments(options.argv || process.argv.slice(2));
  const inputRoot = String(env.HUAMEI_KNOWLEDGE_GOVERNANCE_INPUT_ROOT || "").trim();
  if (String(env.HUAMEI_RUNTIME_ENV || env.NODE_ENV || "").toLowerCase() === "production" && !inputRoot) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_INPUT_ROOT_REQUIRED", "Production governance requires one protected input root");
  }
  const tenantId = String(args.tenant || env.HUAMEI_KNOWLEDGE_GOVERNANCE_TENANT_ID || env.HUAMEI_DEFAULT_TENANT_ID || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(tenantId)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_TENANT_INVALID", "A fixed valid governance tenant is required");
  }
  const callerId = String(env.HUAMEI_KNOWLEDGE_GOVERNANCE_CALLER_ID || "").trim();
  if (!/^[a-z0-9][a-z0-9_.:@/-]{1,127}$/i.test(callerId)) {
    throw governanceError("KNOWLEDGE_GOVERNANCE_CALLER_INVALID", "A dedicated knowledge-governance caller id is required");
  }
  const callerSecretPath = args["caller-secret-file"] || env.HUAMEI_KNOWLEDGE_GOVERNANCE_CALLER_SECRET_FILE;
  const callerSecret = String(await readProtectedFile(callerSecretPath, { label:"caller secret", inputRoot })).trim();
  if (callerSecret.length < 32) throw governanceError("KNOWLEDGE_GOVERNANCE_CALLER_SECRET_WEAK", "Governance caller secret must contain at least 32 characters");

  const operation = operationFor(command, args, tenantId);
  let token = "";
  if (operation.needsIdentity) {
    const tokenPath = args["oidc-token-file"] || env.HUAMEI_KNOWLEDGE_GOVERNANCE_OIDC_TOKEN_FILE;
    token = String(await readProtectedFile(tokenPath, { label:"OIDC token", inputRoot })).trim();
    if (token.length > 16_384 || token.split(".").length !== 3) {
      throw governanceError("KNOWLEDGE_GOVERNANCE_OIDC_TOKEN_INVALID", "OIDC token file does not contain one compact JWT");
    }
  }
  let body = operation.body;
  if (operation.needsPayload) {
    const payloadPath = args["payload-file"] || env.HUAMEI_KNOWLEDGE_GOVERNANCE_PAYLOAD_FILE;
    body = await payloadFrom(payloadPath, tenantId, inputRoot);
  }

  const response = await (options.fetchImpl || fetch)(`${validateBaseUrl(env.HUAMEI_KNOWLEDGE_GOVERNANCE_URL)}${operation.path}`, {
    method:operation.method,
    headers:{
      Accept:"application/json",
      "X-Caller-Id":callerId,
      "X-Service-Key":callerSecret,
      "X-Tenant-Id":tenantId,
      "X-Request-Id":`knowledge-governance-${randomUUID()}`,
      ...(token ? { Authorization:`Bearer ${token}` } : {}),
      ...(body ? { "Content-Type":"application/json" } : {})
    },
    ...(body ? { body:JSON.stringify(body) } : {}),
    signal:AbortSignal.timeout(Math.min(Math.max(Number(env.HUAMEI_KNOWLEDGE_GOVERNANCE_TIMEOUT_MS) || 10_000, 1_000), 30_000))
  });
  let responseBody = {};
  try { responseBody = await response.json(); } catch {}
  if (!response.ok) throw safeRemoteError(responseBody, response.status);
  return {
    status:"completed",
    command,
    tenant_id:tenantId,
    response:responseBody
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    console.log(JSON.stringify(await runKnowledgeGovernance(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status:"failed",
      error:{ code:error?.code || "KNOWLEDGE_GOVERNANCE_FAILED", message:String(error?.message || "Knowledge governance failed").slice(0, 500) }
    }));
    process.exitCode = error?.exitCode || 1;
  }
}
