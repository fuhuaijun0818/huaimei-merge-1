import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const failures = [];
const runCase = async (name, operation) => {
  try {
    await operation();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`✗ ${name}: ${error.message}`);
  }
};

const importContract = async (relativePath) => {
  const absolutePath = join(projectRoot, relativePath);
  try {
    return await import(`${pathToFileURL(absolutePath).href}?contract=${Date.now()}-${Math.random()}`);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(`缺少基础设施契约模块 ${relativePath}`);
    }
    throw error;
  }
};

const errorText = (error) => JSON.stringify({
  code:error?.code,
  message:error?.message,
  details:error?.details,
  issues:error?.issues,
  report:error?.report
});

const expectPreflightFailure = async (assertProductionInfrastructure, env, expectedTerms = []) => {
  let captured;
  try {
    await assertProductionInfrastructure(env);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, "生产基础设施预检必须拒绝不安全配置");
  assert.equal(captured.code, "PRODUCTION_INFRASTRUCTURE_NOT_READY");
  const detail = errorText(captured);
  for (const term of expectedTerms) {
    assert.match(detail, term, `预检错误应明确指出 ${term}`);
  }
};

const productionBase = {
  NODE_ENV:"production",
  DATABASE_URL:"postgresql://huamei:strong-placeholder@postgres:5432/huamei",
  REDIS_URL:"redis://:strong-placeholder@redis:6379/0"
};
const fieldEncryptionKeyring = JSON.stringify({
  active_key_id:"phase1-test-v1",
  keys:{ "phase1-test-v1":Buffer.from("0123456789abcdef0123456789ABCDEF").toString("base64") }
});
const contactVaultKeyring = JSON.stringify({
  active_key_id:"contact-test-v1",
  keys:{ "contact-test-v1":Buffer.from("FEDCBA9876543210fedcba9876543210").toString("base64") }
});

await runCase("M2：生产环境缺少PostgreSQL/Redis配置时预检失败", async () => {
  const { assertProductionInfrastructure } = await importContract("server/platform/production-readiness.mjs");
  assert.equal(typeof assertProductionInfrastructure, "function");
  await expectPreflightFailure(assertProductionInfrastructure, { NODE_ENV:"production" }, [/DATABASE_URL/i, /REDIS_URL/i]);
});

await runCase("M2：生产环境拒绝memory与local_json持久化适配器", async () => {
  const { assertProductionInfrastructure } = await importContract("server/platform/production-readiness.mjs");
  assert.equal(typeof assertProductionInfrastructure, "function");
  await expectPreflightFailure(assertProductionInfrastructure, {
    ...productionBase,
    HUAMEI_PERSISTENCE_DRIVER:"local_json",
    HUAMEI_SESSION_STORE_DRIVER:"memory",
    HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
    HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:"/data/acquisition-operations.json",
    HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:".local-data/knowledge-releases.json",
    HUAMEI_LEAD_STORE_FILE:":memory:"
  }, [/local_json|memory|:memory:|STORE_FILE/i]);
});

await runCase("M2：开发环境允许本地与内存适配器", async () => {
  const { validateInfrastructureConfig, assertProductionInfrastructure } = await importContract("server/platform/production-readiness.mjs");
  assert.equal(typeof validateInfrastructureConfig, "function");
  assert.equal(typeof assertProductionInfrastructure, "function");
  const env = {
    NODE_ENV:"development",
    HUAMEI_PERSISTENCE_DRIVER:"local_json",
    HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
    HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:".local-data/acquisition-operations.json",
    HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
    HUAMEI_LEAD_STORE_FILE:":memory:"
  };
  const report = await validateInfrastructureConfig(env);
  assert.equal(report.ready ?? report.ok, true, `开发环境本地适配器应通过预检：${JSON.stringify(report)}`);
  await assert.doesNotReject(async () => assertProductionInfrastructure(env));
});

await runCase("P0：生产预检强制调用方、租户、权限与独立强密钥", async () => {
  const { parseAcquisitionClientsConfig, validateInfrastructureConfig } = await importContract("server/platform/production-readiness.mjs");
  const callerSecret = "caller_Q7w2E9r4T6y8U1i3O5p0AsDfGhJkLzX";
  const clientsJson = JSON.stringify({
    huamei_web_gateway:{
      secret:callerSecret,
      tenant_ids:["huamei-shanghai"],
      permissions:[
        "service:read", "conversation:write", "privacy:request", "runs:read",
        "operations:read", "operations:write", "contact:reveal"
      ]
    }
  });
  const parsed = parseAcquisitionClientsConfig(clientsJson);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.clients[0].caller_id, "huamei_web_gateway");
  const readyEnvironment = {
    NODE_ENV:"production",
    HUAMEI_PERSISTENCE_BACKEND:"postgres",
    HUAMEI_CACHE_BACKEND:"redis",
    HUAMEI_DATABASE_URL:"postgresql://huamei_runtime:Db9xQ2vN7mK4sP8t@postgres:5432/huamei",
    HUAMEI_REDIS_URL:"redis://:Rd8pL3zX6cV1bN5m@redis:6379/0",
    HUAMEI_API_KEY:"api_A1s3D5f7G9h2J4k6L8q0W2e4R6t8Y0u",
    HUAMEI_IDENTITY_PEPPER:"pep_P9o7I5u3Y1t8R6e4W2q0AsDfGhJkLzX",
    HUAMEI_PUBLIC_SESSION_SECRET:"ses_Z8x6C4v2B0n7M5a3S1d9FgHjKlQwErT",
    HUAMEI_PRIVACY_VERIFICATION_SECRET:"privacy_verify_M2n8Q4w0E6r3T9y1UiOpAsDfGhJkLzX",
    HUAMEI_PRIVACY_COMPLETION_SECRET:"privacy_complete_B5v1C7x3Z9a6S2d8FgHjKlQwErTyUiO",
    HUAMEI_PRIVACY_CANCELLATION_SECRET:"privacy_cancel_C8v4B0n6M2q9W5e1R7t3YuIoPaSdFgHj",
    HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:fieldEncryptionKeyring,
    HUAMEI_CONTACT_VAULT_KEYRING_JSON:contactVaultKeyring,
    HUAMEI_LLM_ENABLED:"true",
    HUAMEI_LLM_PROVIDER:"openai_compatible",
    HUAMEI_LLM_BASE_URL:"https://llm.huamei.internal/v1",
    HUAMEI_LLM_API_KEY:"llm_R4nD0m8V2k6P1s9Q3w7E5t0Y4u8I2o6",
    HUAMEI_LLM_MODEL:"qwen3.7-production",
    HUAMEI_LLM_DATA_EGRESS_APPROVED:"true",
    HUAMEI_GRAPHRAG_ENABLED:"true",
    HUAMEI_GRAPHRAG_SERVICE_KEY:"graph_Q3w7E1r5T9y2U6i0O4p8AsDfGhJkLzX",
    HUAMEI_ACQUISITION_CLIENTS_JSON:clientsJson,
    HUAMEI_ACQUISITION_CALLER_ID:"huamei_web_gateway",
    HUAMEI_ACQUISITION_CALLER_SECRET:callerSecret,
    HUAMEI_DEFAULT_TENANT_ID:"huamei-shanghai",
    HUAMEI_PUBLIC_TENANT_ID:"huamei-shanghai",
    HUAMEI_PUBLIC_GATEWAY_ENABLED:"true",
    HUAMEI_ADMIN_BROWSER_AUTH_MODE:"external_oidc_pkce_proxy",
    HUAMEI_ADMIN_IDENTITY_PROXY_SESSION_BACKEND:"redis",
    HUAMEI_ADMIN_IDENTITY_PROXY_PRODUCT:"oauth2-proxy",
    HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL:"https://admin-sso.huamei.cn/readyz",
    HUAMEI_ADMIN_IDENTITY_PROXY_UPSTREAM_AUTHORIZATION_MODE:"overwrite_verified_bearer",
    HUAMEI_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE:"state_nonce_pkce_origin_logout",
    HUAMEI_ADMIN_IDENTITY_PROXY_HA_REPLICAS:"2",
    HUAMEI_EDGE_BIND_ADDRESS:"127.0.0.1",
    HUAMEI_ADMIN_ORIGIN:"https://admin.huamei.cn",
    HUAMEI_ALLOWED_ORIGINS:"https://advisor.huamei.cn,https://admin.huamei.cn",
    HUAMEI_TRUST_PROXY:"true",
    HUAMEI_TRUSTED_PROXY_ADDRESSES:"172.31.254.2",
    HUAMEI_OIDC_ISSUER:"https://identity.huamei.test",
    HUAMEI_OIDC_AUDIENCE:"huamei-acquisition",
    HUAMEI_OIDC_JWKS_URL:"https://identity.huamei.test/.well-known/jwks.json",
    HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"false"
  };
  const report = validateInfrastructureConfig(readyEnvironment);
  assert.equal(report.ready, true, JSON.stringify(report.errors));
  assert.equal(report.backends.field_encryption_configured, true);
  assert.equal(report.backends.contact_vault_encryption_configured, true);
  assert.equal(report.backends.contact_vault_key_domain_independent, true);
  assert.equal(report.backends.llm_enabled, true);
  assert.equal(report.backends.llm_data_egress_approved, true);
  const rulesOnly = validateInfrastructureConfig({ ...readyEnvironment, HUAMEI_LLM_ENABLED:"false" });
  assert.equal(rulesOnly.ready, false);
  assert.ok(rulesOnly.errors.some((item) => item.code === "PRODUCTION_LLM_REQUIRED"));
  const unapprovedHttp = validateInfrastructureConfig({
    ...readyEnvironment,
    HUAMEI_LLM_BASE_URL:"http://llm.huamei.internal/v1",
    HUAMEI_LLM_INTERNAL_ENDPOINT_APPROVED:"false"
  });
  assert.ok(unapprovedHttp.errors.some((item) => item.code === "PRODUCTION_LLM_HTTPS_REQUIRED"));
  const approvedInternalHttp = validateInfrastructureConfig({
    ...readyEnvironment,
    HUAMEI_LLM_BASE_URL:"http://llm.huamei.internal/v1",
    HUAMEI_LLM_INTERNAL_ENDPOINT_APPROVED:"true"
  });
  assert.equal(approvedInternalHttp.ready, true, JSON.stringify(approvedInternalHttp.errors));
  const untrustedProxy = validateInfrastructureConfig({
    ...readyEnvironment,
    HUAMEI_TRUST_PROXY:"false",
    HUAMEI_TRUSTED_PROXY_ADDRESSES:""
  });
  assert.equal(untrustedProxy.ready, false);
  assert.ok(untrustedProxy.errors.some((item) => item.code === "PRODUCTION_TRUST_PROXY_REQUIRED"));
  assert.ok(untrustedProxy.errors.some((item) => item.code === "PRODUCTION_TRUSTED_PROXY_ADDRESSES_REQUIRED"));
  const publicEdgeBypass = validateInfrastructureConfig({ ...readyEnvironment, HUAMEI_EDGE_BIND_ADDRESS:"0.0.0.0" });
  assert.ok(publicEdgeBypass.errors.some((item) => item.code === "PRODUCTION_EDGE_PRIVATE_BIND_REQUIRED"));
  const incompleteIdentityProxy = validateInfrastructureConfig({
    ...readyEnvironment,
    HUAMEI_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE:"",
    HUAMEI_ADMIN_IDENTITY_PROXY_HA_REPLICAS:"1"
  });
  assert.ok(incompleteIdentityProxy.errors.some((item) => item.code === "PRODUCTION_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE_REQUIRED"));
  assert.ok(incompleteIdentityProxy.errors.some((item) => item.code === "PRODUCTION_ADMIN_IDENTITY_PROXY_HA_REQUIRED"));
  const weakGraphKey = validateInfrastructureConfig({
    ...readyEnvironment,
    HUAMEI_GRAPHRAG_SERVICE_KEY:"x"
  });
  assert.ok(weakGraphKey.errors.some((item) => item.code === "PRODUCTION_GRAPHRAG_SERVICE_KEY_REQUIRED"));
});

await runCase("P0：OIDC代理就绪探针验证真实请求路径契约", async () => {
  const { checkAdminIdentityProxyHealth } = await importContract("server/platform/production-readiness.mjs");
  const env = {
    HUAMEI_PUBLIC_GATEWAY_ENABLED:"true",
    HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL:"https://admin-sso.huamei.cn/readyz"
  };
  const ready = await checkAdminIdentityProxyHealth(env, async (url, options) => {
    assert.equal(url, env.HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL);
    assert.equal(options.redirect, "error");
    return new Response("ok", { status:200, headers:{ "X-Huamei-Identity-Proxy-Contract":"oidc-code-pkce-v1" } });
  });
  assert.equal(ready.ok, true);
  const wrongContract = await checkAdminIdentityProxyHealth(env, async () => new Response("ok", { status:200 }));
  assert.equal(wrongContract.ok, false);
});

await runCase("P0：生产预检拒绝弱密钥、未注册caller和非授权租户", async () => {
  const { validateInfrastructureConfig } = await importContract("server/platform/production-readiness.mjs");
  const report = validateInfrastructureConfig({
    NODE_ENV:"production",
    HUAMEI_PERSISTENCE_BACKEND:"postgres",
    HUAMEI_CACHE_BACKEND:"redis",
    HUAMEI_DATABASE_URL:"postgresql://huamei_runtime:Db9xQ2vN7mK4sP8t@postgres:5432/huamei",
    HUAMEI_REDIS_URL:"redis://:Rd8pL3zX6cV1bN5m@redis:6379/0",
    HUAMEI_API_KEY:"short",
    HUAMEI_IDENTITY_PEPPER:"short",
    HUAMEI_PUBLIC_SESSION_SECRET:"short",
    HUAMEI_PRIVACY_VERIFICATION_SECRET:"short",
    HUAMEI_PRIVACY_COMPLETION_SECRET:"short",
    HUAMEI_PRIVACY_CANCELLATION_SECRET:"short",
    HUAMEI_ACQUISITION_CLIENTS_JSON:JSON.stringify({
      another_connector:{
        secret:"connector_Q7w2E9r4T6y8U1i3O5p0AsDfGhJkL",
        tenant_ids:["tenant-b"],
        permissions:["conversation:write"]
      }
    }),
    HUAMEI_ACQUISITION_CALLER_ID:"huamei_web_gateway",
    HUAMEI_ACQUISITION_CALLER_SECRET:"short",
    HUAMEI_PUBLIC_TENANT_ID:"tenant-a"
  });
  assert.equal(report.ready, false);
  const codes = report.errors.map((item) => item.code);
  assert.ok(codes.includes("PRODUCTION_STRONG_SECRET_REQUIRED"));
  assert.ok(codes.includes("PRODUCTION_ACQUISITION_CALLER_NOT_REGISTERED"));
  assert.ok(codes.includes("PRODUCTION_FIELD_ENCRYPTION_KEYRING_REQUIRED"));
  assert.ok(codes.includes("PRODUCTION_CONTACT_VAULT_KEYRING_REQUIRED"));
  assert.ok(codes.includes("PRODUCTION_PRIVACY_VERIFICATION_SECRET_REQUIRED"));
  assert.ok(codes.includes("PRODUCTION_PRIVACY_COMPLETION_SECRET_REQUIRED"));
  assert.ok(codes.includes("PRODUCTION_PRIVACY_CANCELLATION_SECRET_REQUIRED"));
});

const assertHealthy = (health, driver) => {
  assert.equal(health.ok, true);
  assert.equal(health.status, "ok");
  assert.equal(health.driver, driver);
  assert.equal(health.configured, true);
};

const assertUnhealthy = (health, driver) => {
  assert.equal(health.ok, false);
  assert.equal(health.status, "error");
  assert.equal(health.driver, driver);
  assert.equal(health.configured, true);
};

const assertHealthState = (health, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.equal(health[key], value, `health.${key}不符合契约`);
};

await runCase("M2：PostgreSQL适配器支持依赖注入、health与close", async () => {
  const { createPostgresClient } = await importContract("server/platform/postgres.mjs");
  assert.equal(typeof createPostgresClient, "function");
  const calls = { factory:0, query:[], close:0 };
  const pool = {
    query:async (sql, parameters = []) => {
      calls.query.push({ sql:String(sql), parameters });
      return { rows:[{ value:parameters[0] ?? 1 }], rowCount:1 };
    },
    end:async () => { calls.close += 1; }
  };
  const client = createPostgresClient({
    connectionString:"postgresql://injected.invalid/huamei",
    poolFactory:() => { calls.factory += 1; return pool; },
    env:{}
  });
  assert.equal(typeof client.query, "function");
  assert.equal(typeof client.health, "function");
  assert.equal(typeof client.close, "function");
  assertHealthy(await client.health(), "postgres");
  const result = await client.query("SELECT $1::int AS value", [7]);
  assert.equal(result.rows[0].value, 7);
  assert.equal(calls.factory, 1, "连接池工厂应惰性创建且只创建一次");
  assert.ok(calls.query.some((item) => /select\s+1/i.test(item.sql)), "health必须真实探测数据库连接");
  await client.close();
  assert.equal(calls.close, 1);
  assertHealthState(await client.health(), { ok:false, status:"closed", driver:"postgres", configured:true });

  const unconfigured = createPostgresClient({ connectionString:"", env:{} });
  assertHealthState(await unconfigured.health(), { ok:false, status:"unconfigured", driver:"postgres", configured:false });
  await assert.rejects(() => unconfigured.query("SELECT 1"), (error) => error?.code === "POSTGRES_NOT_CONFIGURED");

  const unavailable = createPostgresClient({
    connectionString:"postgresql://injected.invalid/huamei",
    pool:{ query:async () => { throw new Error("database unavailable"); }, end:async () => {} },
    env:{}
  });
  assertUnhealthy(await unavailable.health(), "postgres");
  await unavailable.close();
});

await runCase("M2：PostgreSQL连接池具备语句、锁、查询与空闲事务超时并接住后台错误", async () => {
  const { createPostgresClient } = await importContract("server/platform/postgres.mjs");
  let capturedOptions;
  let backgroundHandler;
  const connectionString = "postgresql://runtime:do-not-leak@postgres.invalid:5432/huamei";
  const pool = {
    query:async () => ({ rows:[{ ok:1 }], rowCount:1 }),
    on:(event, handler) => { if (event === "error") backgroundHandler = handler; },
    end:async () => {}
  };
  const client = createPostgresClient({
    connectionString,
    statementTimeoutMs:1_250,
    queryTimeoutMs:1_500,
    lockTimeoutMs:350,
    idleInTransactionTimeoutMs:2_000,
    poolFactory:(options) => { capturedOptions = options; return pool; },
    env:{}
  });
  await client.health();
  assert.equal(capturedOptions.statement_timeout, 1_250);
  assert.equal(capturedOptions.query_timeout, 1_500);
  assert.equal(capturedOptions.lock_timeout, 350);
  assert.equal(capturedOptions.idle_in_transaction_session_timeout, 2_000);
  assert.equal(typeof backgroundHandler, "function");
  backgroundHandler(new Error(`idle client failed at ${connectionString}`));
  const health = await client.health();
  assert.equal(health.ok, true, "连接池可继续查询时保持就绪，但保留后台故障证据");
  assert.equal(health.last_background_error.message.includes("do-not-leak"), false);
  assert.match(health.last_background_error.message, /\[redacted\]/);
  await client.close();
});

await runCase("M2：Redis适配器支持依赖注入、health与close", async () => {
  const { createRedisClient } = await importContract("server/platform/redis.mjs");
  assert.equal(typeof createRedisClient, "function");
  const calls = { factory:0, connect:0, ping:0, command:[], close:0 };
  const injected = {
    isOpen:false,
    connect:async function () { calls.connect += 1; this.isOpen = true; },
    ping:async () => { calls.ping += 1; return "PONG"; },
    sendCommand:async (command) => { calls.command.push(command); return "value"; },
    quit:async function () { calls.close += 1; this.isOpen = false; }
  };
  const client = createRedisClient({
    url:"redis://:injected@redis.invalid:6379/0",
    clientFactory:() => { calls.factory += 1; return injected; },
    env:{}
  });
  assert.equal(typeof client.command, "function");
  assert.equal(typeof client.health, "function");
  assert.equal(typeof client.close, "function");
  assertHealthy(await client.health(), "redis");
  assert.equal(await client.command(["GET", "tenant:test:key"]), "value");
  assert.equal(calls.factory, 1, "Redis客户端工厂应惰性创建且只创建一次");
  assert.equal(calls.connect, 1);
  assert.ok(calls.ping >= 1, "health必须真实执行PING");
  await client.close();
  assert.equal(calls.close, 1);
  assertHealthState(await client.health(), { ok:false, status:"closed", driver:"redis", configured:true });

  const unconfigured = createRedisClient({ url:"", env:{} });
  assertHealthState(await unconfigured.health(), { ok:false, status:"unconfigured", driver:"redis", configured:false });
  await assert.rejects(() => unconfigured.command(["PING"]), (error) => error?.code === "REDIS_NOT_CONFIGURED");

  const unavailable = createRedisClient({
    url:"redis://redis.invalid:6379/0",
    client:{ isOpen:true, ping:async () => { throw new Error("redis unavailable"); }, quit:async () => {} },
    env:{}
  });
  assertUnhealthy(await unavailable.health(), "redis");
  await unavailable.close();
});

await runCase("M2：Redis命令有界超时并接住后台错误且不泄露凭据", async () => {
  const { createRedisClient } = await importContract("server/platform/redis.mjs");
  let backgroundHandler;
  const url = "redis://:do-not-leak@redis.invalid:6379/0";
  const injected = {
    isOpen:true,
    ping:async () => "PONG",
    sendCommand:async () => new Promise(() => {}),
    on:(event, handler) => { if (event === "error") backgroundHandler = handler; },
    quit:async () => {}
  };
  const client = createRedisClient({ url, clientFactory:() => injected, commandTimeoutMs:20, env:{} });
  await client.health();
  assert.equal(typeof backgroundHandler, "function");
  backgroundHandler(new Error(`socket failed at ${url}`));
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.last_background_error.message.includes("do-not-leak"), false);
  assert.match(health.last_background_error.message, /\[redacted\]/);
  await assert.rejects(
    () => client.command(["GET", "tenant:test:key"]),
    (error) => error?.code === "REDIS_COMMAND_TIMEOUT"
  );
  await client.close();
});

const requiredTables = [
  "tenants",
  "conversation_sessions",
  "conversation_messages",
  "leads",
  "lead_candidates",
  "consents",
  "handovers",
  "tasks",
  "human_work",
  "knowledge_releases",
  "knowledge_reviews",
  "audit_events",
  "outbox_events",
  "idempotency_records",
  "data_subject_requests",
  "privacy_execution_actions",
  "contact_suppressions",
  "privacy_identity_verifications",
  "privacy_completion_verifications",
  "contact_vault_entries"
];

const tenantScopedTables = requiredTables.filter((table) => table !== "tenants");
const tableBlock = (sql, table) => {
  const pattern = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?["']?${table}["']?\\s*\\(([\\s\\S]*?)\\);`, "i");
  return sql.match(pattern)?.[1] || "";
};

const indexStatementsFor = (sql, table) => {
  const statements = sql.match(/create\s+(?:unique\s+)?index[\s\S]*?;/gi) || [];
  return statements.filter((statement) => new RegExp(`\\bon\\s+(?:public\\.)?["']?${table}["']?\\s*\\(`, "i").test(statement)).join("\n");
};

const hasTenantUniqueKey = (sql, table, identityPattern) => {
  const scope = `${tableBlock(sql, table)}\n${indexStatementsFor(sql, table)}`.replace(/\s+/g, " ");
  return /unique/i.test(scope) && /tenant_id/i.test(scope) && identityPattern.test(scope);
};

const hasTenantAccessIndex = (sql, table) => {
  const explicitIndexes = indexStatementsFor(sql, table);
  if (/tenant_id/i.test(explicitIndexes)) return true;
  // PostgreSQL automatically backs UNIQUE constraints with a b-tree index.
  // When tenant_id is the leading column, a second identical tenant index is
  // redundant and should not be required by the contract.
  return /unique\s*\(\s*tenant_id\b/i.test(tableBlock(sql, table));
};

await runCase("M2：初始PostgreSQL迁移覆盖核心表与租户约束", async () => {
  const migrationsRoot = join(projectRoot, "db", "migrations");
  let migrationNames = [];
  try {
    migrationNames = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql")).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.ok(migrationNames.length, "db/migrations 必须包含可审计的初始SQL迁移");
  const sql = (await Promise.all(migrationNames.map((name) => readFile(join(migrationsRoot, name), "utf8")))).join("\n");
  for (const table of requiredTables) {
    const block = tableBlock(sql, table);
    assert.ok(block, `初始迁移缺少核心表 ${table}`);
    assert.match(block, /\bprimary\s+key\b/i, `${table} 必须定义主键`);
  }
  for (const table of tenantScopedTables) {
    assert.match(tableBlock(sql, table), /\btenant_id\b[\s\S]*?\bnot\s+null\b/i, `${table}.tenant_id 必须为 NOT NULL`);
  }
  assert.ok(hasTenantUniqueKey(sql, "conversation_sessions", /channel[\s\S]*(?:external_conversation_id|conversation_id|session_key)|(?:external_conversation_id|conversation_id|session_key)[\s\S]*channel/i), "会话业务键必须在tenant内唯一");
  assert.ok(hasTenantUniqueKey(sql, "conversation_messages", /(?:external_message_id|message_id)/i), "消息业务键必须在tenant内唯一");
  assert.ok(hasTenantUniqueKey(sql, "idempotency_records", /(?:idempotency_key|scope_key)/i), "幂等键必须在tenant作用域内唯一");
  for (const table of ["conversation_sessions", "conversation_messages", "leads", "lead_candidates", "handovers", "tasks", "human_work", "audit_events", "outbox_events", "idempotency_records", "data_subject_requests", "privacy_execution_actions", "contact_suppressions", "privacy_identity_verifications", "privacy_completion_verifications", "contact_vault_entries"]) {
    assert.ok(hasTenantAccessIndex(sql, table), `${table} 必须有tenant前缀的查询索引或唯一索引`);
  }
});

await runCase("M2：Outbox与不可变审计约束完整", async () => {
  const migrationsRoot = join(projectRoot, "db", "migrations");
  const migrationNames = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql")).sort();
  const sql = (await Promise.all(migrationNames.map((name) => readFile(join(migrationsRoot, name), "utf8")))).join("\n");
  const outbox = tableBlock(sql, "outbox_events");
  for (const field of ["event_type", "payload", "status", "created_at"]) {
    assert.match(outbox, new RegExp(`\\b${field}\\b`, "i"), `outbox_events 缺少 ${field}`);
  }
  assert.match(outbox, /\b(?:attempt_count|attempts)\b/i, "outbox必须记录投递次数");
  assert.match(outbox, /\b(?:available_at|next_attempt_at)\b/i, "outbox必须支持延迟与重试调度");
  assert.match(outbox, /check\s*\([\s\S]*?status/i, "outbox状态必须有数据库CHECK约束");
  assert.match(outbox, /check\s*\([\s\S]*?(?:attempt_count|attempts)[\s\S]*?>=\s*0/i, "outbox投递次数不能为负数");
  const immutableAudit = /(?:create\s+(?:or\s+replace\s+)?function[\s\S]*?audit[\s\S]*?raise\s+exception[\s\S]*?create\s+trigger[\s\S]*?audit_events)|(?:revoke\s+[\s\S]*?update[\s\S]*?delete[\s\S]*?audit_events)/i.test(sql);
  assert.ok(immutableAudit, "audit_events 必须由数据库约束为不可UPDATE/DELETE的追加式审计账本");
});

const listComposeFiles = async (root) => {
  const result = [];
  const visit = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes:true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/compose.*\.ya?ml$|docker-compose.*\.ya?ml$/i.test(entry.name)) result.push(absolute);
    }
  };
  await visit(root);
  return result.sort();
};

const serviceBlocks = (yaml) => {
  const lines = yaml.split(/\r?\n/);
  const servicesStart = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
  if (servicesStart < 0) return new Map();
  const result = new Map();
  let current = null;
  for (let index = servicesStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:\s*(?:#.*)?$/.test(line)) break;
    const service = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/)?.[1];
    if (service) {
      current = service;
      result.set(current, []);
      continue;
    }
    if (current) result.get(current).push(line);
  }
  return new Map([...result].map(([name, linesForService]) => [name, linesForService.join("\n")]));
};

const assertNoWeakCredentials = (yaml, sourceName) => {
  assert.doesNotMatch(yaml, /(?:password|passwd|secret|token)\s*[:=]\s*["']?(?:password|postgres|redis|admin|root|changeme|change-me|huamei|123456(?:78)?)["']?\s*(?:#.*)?$/gim, `${sourceName} 不能包含明文弱口令`);
  assert.doesNotMatch(yaml, /\$\{[^}:]*(?:password|passwd|secret|token)[^}:]*:-(?:password|postgres|redis|admin|root|changeme|change-me|huamei|123456(?:78)?)\}/gi, `${sourceName} 不能为密码配置弱默认值`);
};

await runCase("M2：deploy/local提供安全的PostgreSQL16与Redis7", async () => {
  const files = await listComposeFiles(join(projectRoot, "deploy", "local"));
  assert.ok(files.length, "deploy/local 必须提供独立的本地基础设施Compose");
  const yaml = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assertNoWeakCredentials(yaml, "deploy/local Compose");
  const services = serviceBlocks(yaml);
  const postgres = services.get("postgres") || "";
  const redis = services.get("redis") || "";
  assert.ok(postgres, "本地Compose缺少postgres服务");
  assert.ok(redis, "本地Compose缺少redis服务");
  assert.match(postgres, /image:\s*["']?postgres:16(?:[-.][A-Za-z0-9_-]+)?["']?/i, "本地数据库必须基于PostgreSQL 16");
  assert.match(redis, /image:\s*["']?redis:7(?:[-.][A-Za-z0-9_-]+)?["']?/i, "本地缓存必须基于Redis 7");
  assert.match(postgres, /healthcheck:/i, "postgres必须提供healthcheck");
  assert.match(redis, /healthcheck:/i, "redis必须提供healthcheck");
  assert.match(postgres, /POSTGRES_PASSWORD[}:]/i, "PostgreSQL密码必须由环境变量注入");
  assert.match(redis, /(?:REDIS_PASSWORD|requirepass)/i, "Redis必须启用环境变量注入的认证密码");
  const adminer = services.get("adminer");
  if (adminer) {
    assert.match(adminer, /depends_on:[\s\S]*?postgres:[\s\S]*?condition:\s*service_healthy/i, "Adminer必须等待PostgreSQL健康后启动");
  }
});

await runCase("M2集成门禁：外测Compose使用生产基础设施且服务健康检查齐全", async () => {
  const composePath = join(projectRoot, "deploy", "docker-compose.example.yml");
  const yaml = await readFile(composePath, "utf8");
  assertNoWeakCredentials(yaml, "外测Compose");
  const services = serviceBlocks(yaml);
  const violations = [];
  const requireContract = (condition, message) => { if (!condition) violations.push(message); };
  for (const name of ["graphrag", "acquisition", "app", "caddy"]) {
    const block = services.get(name) || "";
    requireContract(Boolean(block), `外测Compose缺少${name}服务`);
    requireContract(/healthcheck:/i.test(block), `外测Compose的${name}必须提供healthcheck`);
  }
  for (const name of ["acquisition", "app"]) {
    const block = services.get(name) || "";
    requireContract(/DATABASE_URL:/.test(block), `${name}生产服务必须注入DATABASE_URL`);
    requireContract(/REDIS_URL:/.test(block), `${name}生产服务必须注入REDIS_URL`);
    requireContract(!/HUAMEI_(?:LEAD|ACQUISITION_SESSION|ACQUISITION_OPERATIONS|KNOWLEDGE_RELEASE)_STORE_FILE|\.json\b/i.test(block), `${name}生产服务不得退回本地JSON存储`);
  }
  assert.equal(violations.length, 0, `外测部署尚未达到生产基础设施门禁：\n- ${violations.join("\n- ")}`);
});

if (failures.length) {
  throw new AggregateError(
    failures.map((item) => item.error),
    `${failures.length}项M2基础设施契约尚未通过：${failures.map((item) => item.name).join("；")}`
  );
}
