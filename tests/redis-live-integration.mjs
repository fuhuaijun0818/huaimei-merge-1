import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const redisUrl = String(process.env.HUAMEI_REDIS_URL || process.env.REDIS_URL || "").trim();
if (!redisUrl) throw new Error("真实Redis集成测试需要HUAMEI_REDIS_URL");

const { createRedisClient } = await import("../server/platform/redis.mjs");
const { createRedisFixedWindowStore, createRedisIdempotencyStore } = await import("../server/platform/request-security.mjs");
const firstClient = createRedisClient({ url:redisUrl });
const secondClient = createRedisClient({ url:redisUrl });
const namespace = `huamei:ci:${randomUUID()}`;

try {
  assert.equal((await firstClient.health()).ok, true);
  assert.equal((await secondClient.health()).ok, true);

  const rateA = createRedisFixedWindowStore({ redis:firstClient, namespace:`${namespace}:rate` });
  const rateB = createRedisFixedWindowStore({ redis:secondClient, namespace:`${namespace}:rate` });
  const rateResults = await Promise.all(Array.from({ length:40 }, (_, index) => (
    index % 2 ? rateA : rateB
  ).consume("tenant-a:visitor-a", { limit:13, windowMs:60_000 })));
  assert.equal(rateResults.filter((item) => item.allowed).length, 13, "两个客户端必须共享同一原子限流窗口");

  const idemA = createRedisIdempotencyStore({ redis:firstClient, namespace:`${namespace}:idem`, ttlMs:30_000 });
  const idemB = createRedisIdempotencyStore({ redis:secondClient, namespace:`${namespace}:idem`, ttlMs:30_000 });
  const claims = await Promise.all(Array.from({ length:24 }, (_, index) => (
    index % 2 ? idemA : idemB
  ).claim("tenant-a:conversation-a:request-a", "payload-hash")));
  const winners = claims.filter((item) => item.status === "claimed");
  assert.equal(winners.length, 1, "真实Redis原子claim必须只有一个winner");
  assert.equal(await idemA.complete(
    "tenant-a:conversation-a:request-a",
    { status:"ok" },
    winners[0].token
  ), true);
  assert.deepEqual((await idemB.claim("tenant-a:conversation-a:request-a", "payload-hash")).value, { status:"ok" });

  console.log("✓ 真实Redis连通性、多客户端原子限流与幂等claim通过");
} finally {
  await Promise.allSettled([firstClient.close(), secondClient.close()]);
}
