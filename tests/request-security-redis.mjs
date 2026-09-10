import assert from "node:assert/strict";

import {
  canonicalPayloadHash,
  createMemoryFixedWindowStore,
  createMemoryIdempotencyStore,
  createRedisFixedWindowStore,
  createRedisIdempotencyStore,
  createRequestSecurityStores,
  scopedKey
} from "../server/platform/request-security.mjs";
import { createProductionReadiness } from "../server/platform/production-readiness.mjs";

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

/**
 * Deterministic Redis double for request-security store contracts.
 *
 * It deliberately implements only the Redis primitives the stores are allowed
 * to need. Commands mutate synchronously before their promise resolves, which
 * gives INCR and SET NX the same single-winner property that the real Redis
 * command stream provides under Promise.all concurrency.
 */
const createFakeRedis = ({ now = 1_700_000_000_000, healthy = true } = {}) => {
  const entries = new Map();
  const calls = [];
  let clock = now;
  let available = healthy;

  const purge = (key) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock) entries.delete(key);
  };
  const read = (key) => {
    purge(key);
    return entries.get(key) || null;
  };
  const normalizeCommand = (name, arguments_) => {
    const parts = Array.isArray(name) ? name : [name, ...arguments_];
    return [String(parts[0] || "").toUpperCase(), ...parts.slice(1)];
  };

  const command = async (name, ...arguments_) => {
    if (!available) throw Object.assign(new Error("redis unavailable"), { code:"ECONNREFUSED" });
    const [operation, ...parts] = normalizeCommand(name, arguments_);
    calls.push([operation, ...parts]);

    if (operation === "PING") return "PONG";
    if (operation === "GET") return read(parts[0])?.value ?? null;
    if (operation === "INCR") {
      const key = parts[0];
      const previous = read(key);
      const value = Number(previous?.value || 0) + 1;
      entries.set(key, { value:String(value), expiresAt:previous?.expiresAt ?? null });
      return value;
    }
    if (operation === "EXPIRE" || operation === "PEXPIRE") {
      const [key, rawDuration] = parts;
      const entry = read(key);
      if (!entry) return 0;
      const multiplier = operation === "EXPIRE" ? 1_000 : 1;
      entry.expiresAt = clock + Math.max(0, Number(rawDuration)) * multiplier;
      return 1;
    }
    if (operation === "SET") {
      const [key, value, ...passedOptions] = parts;
      const rawOptions = passedOptions.length === 1 && passedOptions[0] && typeof passedOptions[0] === "object"
        ? Object.entries(passedOptions[0]).flatMap(([option, optionValue]) => optionValue === true ? [option] : [option, optionValue])
        : passedOptions;
      const options = rawOptions.map((item) => String(item).toUpperCase());
      if (options.includes("NX") && read(key)) return null;
      let expiresAt = null;
      const pxIndex = options.indexOf("PX");
      const exIndex = options.indexOf("EX");
      if (pxIndex >= 0) expiresAt = clock + Number(rawOptions[pxIndex + 1]);
      if (exIndex >= 0) expiresAt = clock + Number(rawOptions[exIndex + 1]) * 1_000;
      entries.set(key, { value, expiresAt });
      return "OK";
    }
    if (operation === "DEL") {
      let deleted = 0;
      for (const key of parts) {
        purge(key);
        deleted += entries.delete(key) ? 1 : 0;
      }
      return deleted;
    }
    throw Object.assign(new Error(`fake Redis does not implement ${operation}`), { code:"UNSUPPORTED_FAKE_COMMAND" });
  };

  return {
    driver:"fake_redis",
    configured:true,
    command,
    get:(key) => command("GET", key),
    set:(key, value, options) => {
      if (options === undefined) return command("SET", key, value);
      if (typeof options === "object" && options !== null) {
        const parts = [];
        if (options.NX || options.nx) parts.push("NX");
        if (options.PX !== undefined || options.px !== undefined) parts.push("PX", options.PX ?? options.px);
        if (options.EX !== undefined || options.ex !== undefined) parts.push("EX", options.EX ?? options.ex);
        return command("SET", key, value, ...parts);
      }
      return command("SET", key, value, options);
    },
    del:(...keys) => command("DEL", ...keys),
    expire:(key, seconds) => command("EXPIRE", key, seconds),
    health:async () => available
      ? { ok:true, status:"ok", driver:"redis", configured:true }
      : { ok:false, status:"error", driver:"redis", configured:true, error:{ code:"ECONNREFUSED" } },
    close:async () => {},
    advance(milliseconds) { clock += milliseconds; },
    setHealthy(value) { available = Boolean(value); },
    keys() {
      for (const key of entries.keys()) purge(key);
      return [...entries.keys()];
    },
    ttlMs(key) {
      const entry = read(key);
      return entry?.expiresAt === null || !entry ? null : Math.max(0, entry.expiresAt - clock);
    },
    calls
  };
};

await runCase("M2：Redis固定窗口在多个实例间共享且并发计数原子", async () => {
  assert.equal(typeof createRedisFixedWindowStore, "function", "缺少Redis固定窗口Store");
  const redis = createFakeRedis();
  const firstReplica = createRedisFixedWindowStore({ redis, namespace:"test:rate" });
  const secondReplica = createRedisFixedWindowStore({ redis, namespace:"test:rate" });
  assert.match(firstReplica.driver, /redis/i);

  const now = 1_700_000_000_000;
  const results = await Promise.all(Array.from({ length:80 }, (_, index) => (
    index % 2 ? firstReplica : secondReplica
  ).consume("tenant-a:visitor-a:chat", { limit:37, windowMs:60_000, now })));

  assert.equal(results.filter((item) => item.allowed).length, 37, "共享窗口只能放行全局limit次，而非每副本各limit次");
  assert.equal(results.filter((item) => !item.allowed).length, 43);
  assert.equal(Math.min(...results.map((item) => item.remaining)), 0);
  assert.ok(results.every((item) => !Number.isNaN(Date.parse(item.resetAt))), "每次消费必须返回确定的窗口重置时间");
  assert.equal(redis.calls.filter(([name]) => name === "INCR").length, 80, "每次请求必须通过Redis原子INCR计数");
});

await runCase("M2：固定窗口按租户、访客和时间窗口隔离并设置TTL", async () => {
  const redis = createFakeRedis();
  const store = createRedisFixedWindowStore({ redis, namespace:"test:isolation" });
  const now = 1_700_000_000_000;

  const keyA = scopedKey("tenant-a", "visitor-a", "chat");
  const keyB = scopedKey("tenant-a", "visitor-b", "chat");
  const keyC = scopedKey("tenant-b", "visitor-a", "chat");
  assert.equal((await store.consume(keyA, { limit:1, windowMs:10_000, now })).allowed, true);
  assert.equal((await store.consume(keyA, { limit:1, windowMs:10_000, now })).allowed, false);
  assert.equal((await store.consume(keyB, { limit:1, windowMs:10_000, now })).allowed, true, "不同访客不能共享限流桶");
  assert.equal((await store.consume(keyC, { limit:1, windowMs:10_000, now })).allowed, true, "不同租户不能共享限流桶");
  assert.equal((await store.consume(keyA, { limit:1, windowMs:10_000, now:now + 10_000 })).allowed, true, "新窗口应重新放行");

  const expiringKeys = redis.keys().filter((key) => key.startsWith("test:isolation:"));
  assert.ok(expiringKeys.length >= 4, "窗口键必须包含时间窗口，避免新旧窗口竞争");
  assert.ok(expiringKeys.every((key) => Number(redis.ttlMs(key)) > 0), "所有窗口计数都必须设置TTL");
  redis.advance(30_000);
  assert.equal(redis.keys().filter((key) => key.startsWith("test:isolation:")).length, 0, "过期窗口不得永久占用Redis");
});

await runCase("M2：Redis幂等Store支持重放、TTL和租户会话隔离", async () => {
  assert.equal(typeof createRedisIdempotencyStore, "function", "缺少Redis幂等Store");
  const redis = createFakeRedis();
  const store = createRedisIdempotencyStore({ redis, namespace:"test:idem", ttlMs:2_000 });
  assert.match(store.driver, /redis/i);

  const request = { tenant_id:"tenant-a", conversation_id:"conversation-a", message:"我想了解隆胸" };
  const response = { status:200, body:{ answer:"想要自然一点，还是更饱满一点？" } };
  const tenantAKey = scopedKey("tenant-a", "visitor-a", "conversation-a", "reply", "same-key");
  const tenantBKey = scopedKey("tenant-b", "visitor-a", "conversation-a", "reply", "same-key");
  await store.put(tenantAKey, { payload_hash:canonicalPayloadHash(request), payload:response });

  assert.deepEqual(await store.get(tenantAKey), { payload_hash:canonicalPayloadHash(request), payload:response }, "相同作用域必须完整重放响应");
  assert.equal(await store.get(tenantBKey), null, "相同幂等键不得跨租户重放");
  await store.put(tenantBKey, { payload_hash:canonicalPayloadHash({ ...request, tenant_id:"tenant-b" }), payload:{ status:202 } });
  assert.notDeepEqual(await store.get(tenantAKey), await store.get(tenantBKey));

  redis.advance(2_001);
  assert.equal(await store.get(tenantAKey), null, "幂等记录必须按配置TTL过期");
  assert.equal(await store.get(tenantBKey), null);
});

await runCase("M2：幂等claim在并发竞争中只有一个执行者，并区分重放与载荷冲突", async () => {
  const redis = createFakeRedis();
  const firstReplica = createRedisIdempotencyStore({ redis, namespace:"test:claim", ttlMs:30_000 });
  const secondReplica = createRedisIdempotencyStore({ redis, namespace:"test:claim", ttlMs:30_000 });
  assert.equal(typeof firstReplica.claim, "function", "Redis幂等Store必须提供原子claim，禁止GET后PUT竞态");
  assert.equal(typeof firstReplica.complete, "function");
  assert.equal(typeof firstReplica.release, "function");

  const key = scopedKey("tenant-a", "visitor-a", "conversation-a", "reply", "request-001");
  const payloadHash = canonicalPayloadHash({ message:"推荐哪个医生？" });
  const claims = await Promise.all(Array.from({ length:40 }, (_, index) => (
    index % 2 ? firstReplica : secondReplica
  ).claim(key, payloadHash, { waitMs:0 })));
  const winners = claims.filter((item) => item.status === "claimed");
  assert.equal(winners.length, 1, `原子claim必须只有一个winner，实际：${JSON.stringify(claims)}`);
  assert.ok(winners[0].token, "winner必须获得只能用于完成本次请求的token");
  assert.ok(claims.filter((item) => item.status === "pending").length >= 1, "并发同载荷应返回pending而不是重复执行");

  const conflicting = await secondReplica.claim(key, canonicalPayloadHash({ message:"同一个键但不同载荷" }), { waitMs:0 });
  assert.equal(conflicting.status, "conflict", "相同作用域和幂等键的不同载荷必须明确冲突");

  const completedPayload = { status:200, body:{ answer:"可先说说您更关注医生经验还是审美风格？" } };
  assert.equal(await firstReplica.complete(key, completedPayload, winners[0].token), true, "合法winner应能完成记录");
  const replay = await secondReplica.claim(key, payloadHash, { waitMs:0 });
  assert.equal(replay.status, "replay");
  assert.deepEqual(replay.value, completedPayload, "完成后其他副本必须读取同一响应");

  assert.equal(await secondReplica.complete(key, { status:500 }, "wrong-token"), false, "非owner不得覆写幂等结果");
  const conflictAfterComplete = await firstReplica.claim(key, canonicalPayloadHash({ message:"再次改变载荷" }), { waitMs:0 });
  assert.equal(conflictAfterComplete.status, "conflict", "完成后的幂等键同样必须校验载荷哈希");
});

await runCase("M2：claim失败释放后可安全重试，且锁记录遵守TTL", async () => {
  const redis = createFakeRedis();
  const store = createRedisIdempotencyStore({ redis, namespace:"test:release", ttlMs:1_000, lockTtlMs:1_000 });
  const hash = canonicalPayloadHash({ message:"建立咨询档案" });

  const first = await store.claim("tenant-a:conversation-a:request", hash, { waitMs:0 });
  assert.equal(first.status, "claimed");
  assert.equal(await store.release("tenant-a:conversation-a:request", "wrong-token"), false, "错误token不能释放其他执行者的claim");
  assert.equal((await store.claim("tenant-a:conversation-a:request", hash, { waitMs:0 })).status, "pending");
  assert.equal(await store.release("tenant-a:conversation-a:request", first.token), true);
  assert.equal((await store.claim("tenant-a:conversation-a:request", hash, { waitMs:0 })).status, "claimed", "业务失败释放后应允许重试");

  redis.advance(1_001);
  const recovered = await store.claim("tenant-a:conversation-a:request", hash, { waitMs:0 });
  assert.equal(recovered.status, "claimed", "遗留claim过期后应自动恢复，不能永久阻塞会话");
  assert.notEqual(recovered.token, first.token, "重新claim必须生成新owner token，防止ABA覆写");
  assert.equal(await store.complete("tenant-a:conversation-a:request", { status:500 }, first.token), false, "过期owner不得覆写新claim");
  assert.equal(await store.release("tenant-a:conversation-a:request", first.token), false, "过期owner不得释放新claim");
});

await runCase("M2：开发环境默认memory，生产环境禁止静默降级并选择Redis", async () => {
  assert.equal(typeof createRequestSecurityStores, "function", "缺少环境感知的request security store工厂");
  const development = await createRequestSecurityStores({ env:{ NODE_ENV:"development" } });
  assert.match(development.fixedWindowStore.driver, /memory/i);
  assert.match(development.idempotencyStore.driver, /memory/i);
  assert.equal(development.backend, "memory");
  assert.ok(development.fixedWindowStore.consume && development.idempotencyStore.get);

  const redis = createFakeRedis();
  const production = await createRequestSecurityStores({
    env:{
      NODE_ENV:"production",
      HUAMEI_CACHE_BACKEND:"redis",
      HUAMEI_REDIS_URL:"redis://:unit-test-secret@cache.internal:6379/0"
    },
    redis
  });
  assert.match(production.fixedWindowStore.driver, /redis/i);
  assert.match(production.idempotencyStore.driver, /redis/i);
  assert.equal(production.backend, "redis");

  await assert.rejects(
    async () => createRequestSecurityStores({ env:{ NODE_ENV:"production", HUAMEI_CACHE_BACKEND:"memory" } }),
    (error) => /redis|production/i.test(`${error?.code} ${error?.message}`),
    "生产环境不得因Redis缺失而静默使用进程内Store"
  );
  const unavailable = createFakeRedis({ healthy:false });
  await assert.rejects(
    async () => createRequestSecurityStores({
      env:{ NODE_ENV:"production", HUAMEI_CACHE_BACKEND:"redis", HUAMEI_REDIS_URL:"redis://:unit-test-secret@cache.internal:6379/0" },
      redis:unavailable
    }),
    (error) => /redis|ready|unavailable|ECONNREFUSED/i.test(`${error?.code} ${error?.message}`),
    "生产启动时Redis不可用必须fail closed"
  );
});

await runCase("M2：memory fallback保持原有开发契约", async () => {
  const rate = createMemoryFixedWindowStore();
  const idem = createMemoryIdempotencyStore({ ttlMs:10_000 });
  assert.equal((await rate.consume("dev:visitor", { limit:1, windowMs:1_000, now:10_000 })).allowed, true);
  assert.equal((await rate.consume("dev:visitor", { limit:1, windowMs:1_000, now:10_000 })).allowed, false);
  await idem.put("dev:key", { payload_hash:"hash", payload:{ ok:true } });
  assert.deepEqual(await idem.get("dev:key"), { payload_hash:"hash", payload:{ ok:true } });
});

const productionEnv = {
  NODE_ENV:"production",
  HUAMEI_PERSISTENCE_BACKEND:"postgres",
  HUAMEI_CACHE_BACKEND:"redis",
  HUAMEI_DATABASE_URL:"postgresql://huamei_runtime:unit-test-secret@postgres.internal:5432/huamei",
  HUAMEI_REDIS_URL:"redis://:unit-test-secret@redis.internal:6379/0",
  HUAMEI_API_KEY:"api_Y7w2E9r4T6y8U1i3O5p0AsDfGhJkLzX",
  HUAMEI_IDENTITY_PEPPER:"pep_P9o7I5u3Y1t8R6e4W2q0AsDfGhJkLzX",
  HUAMEI_PUBLIC_SESSION_SECRET:"ses_Z8x6C4v2B0n7M5a3S1d9FgHjKlQwErT",
  HUAMEI_PRIVACY_VERIFICATION_SECRET:"privacy_verify_M2n8Q4w0E6r3T9y1UiOpAsDfGhJkLzX",
  HUAMEI_PRIVACY_COMPLETION_SECRET:"privacy_complete_B5v1C7x3Z9a6S2d8FgHjKlQwErTyUiO",
  HUAMEI_PRIVACY_CANCELLATION_SECRET:"privacy_cancel_C8v4B0n6M2q9W5e1R7t3YuIoPaSdFgHj",
  HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:JSON.stringify({
    active_key_id:"request-security-v1",
    keys:{ "request-security-v1":Buffer.from("0123456789abcdef0123456789ABCDEF").toString("base64") }
  }),
  HUAMEI_CONTACT_VAULT_KEYRING_JSON:JSON.stringify({
    active_key_id:"request-contact-v1",
    keys:{ "request-contact-v1":Buffer.from("FEDCBA9876543210fedcba9876543210").toString("base64") }
  }),
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"openai_compatible",
  HUAMEI_LLM_BASE_URL:"https://llm.huamei.internal/v1",
  HUAMEI_LLM_API_KEY:"llm_W8m2N6v0C4x9Z3a7S1d5F9g2H6j0K4p",
  HUAMEI_LLM_MODEL:"qwen3.7-production",
  HUAMEI_LLM_DATA_EGRESS_APPROVED:"true",
  HUAMEI_ACQUISITION_CLIENTS_JSON:JSON.stringify({
    huamei_web_gateway:{
      secret:"caller_Q7w2E9r4T6y8U1i3O5p0AsDfGhJkLzX",
      tenant_ids:["huamei-shanghai"],
      permissions:[
        "service:read", "conversation:write", "privacy:request", "runs:read",
        "operations:read", "operations:write", "contact:reveal"
      ]
    }
  }),
  HUAMEI_ACQUISITION_CALLER_ID:"huamei_web_gateway",
  HUAMEI_ACQUISITION_CALLER_SECRET:"caller_Q7w2E9r4T6y8U1i3O5p0AsDfGhJkLzX",
  HUAMEI_PUBLIC_TENANT_ID:"huamei-shanghai",
  HUAMEI_ACQUISITION_TENANT_ID:"huamei-shanghai",
  HUAMEI_PUBLIC_GATEWAY_ENABLED:"false",
  HUAMEI_OIDC_ISSUER:"https://identity.huamei.test",
  HUAMEI_OIDC_AUDIENCE:"huamei-acquisition",
  HUAMEI_OIDC_JWKS_URL:"https://identity.huamei.test/.well-known/jwks.json"
};

const dependency = (driver, ok) => ({
  health:async () => ok
    ? { ok:true, status:"ok", driver, configured:true }
    : { ok:false, status:"error", driver, configured:true, error:{ code:`${driver.toUpperCase()}_UNAVAILABLE` } },
  close:async () => {},
  ...(driver === "postgres" ? {
    tenantQuery:async () => ({ rows:[{ relation:"contact_vault_entries" }], rowCount:1 })
  } : {})
});

await runCase("M2：生产readiness对PostgreSQL或Redis任一故障均fail closed", async () => {
  for (const [postgresOk, redisOk, failedDriver] of [
    [false, true, "postgres"],
    [true, false, "redis"],
    [false, false, "postgres_and_redis"]
  ]) {
    const readiness = createProductionReadiness({
      env:productionEnv,
      postgres:dependency("postgres", postgresOk),
      redis:dependency("redis", redisOk)
    });
    const report = await readiness.health();
    assert.equal(report.ok, false, `${failedDriver}故障时readiness不能返回ok`);
    assert.equal(report.status, "not_ready");
    assert.equal(report.configuration.ready, true, "本用例配置本身应有效，失败必须来自真实依赖探测");
    assert.equal(report.dependencies.postgres.ok, postgresOk);
    assert.equal(report.dependencies.redis.ok, redisOk);
    await readiness.close();
  }

  const ready = createProductionReadiness({
    env:productionEnv,
    postgres:dependency("postgres", true),
    redis:dependency("redis", true)
  });
  const report = await ready.health();
  assert.equal(report.ok, true);
  assert.equal(report.status, "ready");
  await ready.close();
});

if (failures.length) {
  console.error(`\n${failures.length} Redis request-security contract case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nRedis request-security contracts passed.");
}
