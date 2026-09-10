import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const databaseUrl = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("该集成测试需要 HUAMEI_DATABASE_URL");
const migrationDatabaseUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
if (!migrationDatabaseUrl) throw new Error("该集成测试需要独立 HUAMEI_MIGRATION_DATABASE_URL");

const tenantId = `it-outbox-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { createPostgresOutboxStore } = await import("../server/persistence/postgres-outbox-store.mjs");
const { createHttpOutboxPublisher, createPostgresOutboxWorker } = await import("../server/workers/postgres-outbox-worker.mjs");

const databaseA = createPostgresClient({ connectionString:databaseUrl, applicationName:"huamei-outbox-it-a" });
const databaseB = createPostgresClient({ connectionString:databaseUrl, applicationName:"huamei-outbox-it-b" });
const migrationDatabase = createPostgresClient({ connectionString:migrationDatabaseUrl, applicationName:"huamei-outbox-it-migrator" });
const storeA = createPostgresOutboxStore({ postgres:databaseA, leaseMs:10_000, baseRetryMs:5_000, maxRetryMs:60_000 });
const storeB = createPostgresOutboxStore({ postgres:databaseB, leaseMs:10_000, baseRetryMs:5_000, maxRetryMs:60_000 });

const enqueue = (store, eventId, options = {}) => store.enqueue({
  tenantId,
  eventId,
  aggregateType:"integration_test",
  aggregateId:eventId,
  eventType:options.eventType || "integration.test.created",
  payload:options.payload || { eventId },
  headers:options.headers || { source:"postgres-outbox-integration" },
  maxAttempts:options.maxAttempts || 8,
  availableAt:options.availableAt || null
});

const forceAvailable = (eventId) => databaseA.tenantQuery(
  tenantId,
  `UPDATE outbox_events
   SET available_at=clock_timestamp() - interval '1 second'
   WHERE tenant_id=$1 AND event_id=$2`,
  [tenantId, eventId]
);

try {
  const runtimeIdentity = await databaseA.query(
    `SELECT current_user AS role_name, rolsuper, rolbypassrls
     FROM pg_roles
     WHERE rolname=current_user`
  );
  assert.equal(runtimeIdentity.rowCount, 1);
  assert.equal(runtimeIdentity.rows[0].role_name, "huamei_runtime", "HUAMEI_DATABASE_URL必须使用huamei_runtime角色");
  assert.equal(runtimeIdentity.rows[0].rolsuper, false, "runtime角色不得是超级用户");
  assert.equal(runtimeIdentity.rows[0].rolbypassrls, false, "runtime角色不得绕过RLS");

  const migrationIdentity = await migrationDatabase.query("SELECT current_user AS role_name");
  assert.equal(
    migrationIdentity.rows[0].role_name,
    "huamei_migrator",
    "HUAMEI_MIGRATION_DATABASE_URL必须使用huamei_migrator角色"
  );
  await migrationDatabase.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    const ownerIdentity = await client.query("SELECT current_user AS role_name, session_user AS session_role");
    assert.equal(ownerIdentity.rows[0].role_name, "huamei_owner");
    assert.equal(ownerIdentity.rows[0].session_role, "huamei_migrator");
    await client.query(
      `INSERT INTO tenants (tenant_id, display_name)
       VALUES ($1,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, tenantId]
    );
  });
  const schema = await databaseA.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='outbox_events'
       AND column_name IN ('lease_token','lease_expires_at','max_attempts','dead_lettered_at','delivery_receipt')`
  );
  assert.equal(schema.rowCount, 5, "请先执行004_outbox_delivery.sql迁移");

  let deliveredRequest;
  const httpPublisher = createHttpOutboxPublisher({
    url:"https://events.example.invalid/v1/events",
    environment:"production",
    serviceKey:"integration-service-key",
    fetchImpl:async (url, request) => {
      deliveredRequest = { url:String(url), request };
      return new Response(null, { status:202, headers:{ "X-Event-Receipt-Id":"receipt-1" } });
    }
  });
  const httpReceipt = await httpPublisher({
    tenantId,
    eventId:"evt-http-contract",
    eventType:"integration.http",
    aggregateType:"integration_test",
    aggregateId:"http-contract",
    attempt:1,
    createdAt:new Date().toISOString(),
    payload:{ ok:true },
    headers:{}
  });
  assert.equal(deliveredRequest.request.headers["Idempotency-Key"], "evt-http-contract");
  assert.equal(deliveredRequest.request.headers["X-Huamei-Tenant-Id"], tenantId);
  assert.equal(JSON.parse(deliveredRequest.request.body).event_id, "evt-http-contract");
  assert.equal(httpReceipt.receiptId, "receipt-1");

  const stableId = `evt-stable-${randomUUID()}`;
  const stableAvailableAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const first = await enqueue(storeA, stableId, { payload:{ value:1 }, availableAt:stableAvailableAt });
  const replay = await enqueue(storeB, stableId, { payload:{ value:1 }, availableAt:stableAvailableAt });
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  await assert.rejects(
    enqueue(storeB, stableId, { payload:{ value:2 } }),
    (error) => error.code === "OUTBOX_EVENT_ID_CONFLICT"
  );

  const concurrentIds = Array.from({ length:20 }, (_, index) => `evt-concurrent-${index}-${randomUUID()}`);
  await Promise.all(concurrentIds.map((eventId) => enqueue(storeA, eventId)));
  const [claimedA, claimedB] = await Promise.all([
    storeA.claimBatch({ tenantId, workerId:"worker-a", batchSize:10, leaseMs:10_000 }),
    storeB.claimBatch({ tenantId, workerId:"worker-b", batchSize:10, leaseMs:10_000 })
  ]);
  const idsA = new Set(claimedA.map((event) => event.eventId));
  const idsB = new Set(claimedB.map((event) => event.eventId));
  assert.equal(claimedA.length + claimedB.length, 20);
  assert.deepEqual([...idsA].filter((eventId) => idsB.has(eventId)), []);
  assert.deepEqual(new Set([...idsA, ...idsB]), new Set(concurrentIds));
  await Promise.all([
    ...claimedA.map((event) => storeA.markPublished({
      tenantId, eventId:event.eventId, workerId:"worker-a", leaseToken:event.leaseToken,
      receipt:{ sink:"integration", event_id:event.eventId }
    })),
    ...claimedB.map((event) => storeB.markPublished({
      tenantId, eventId:event.eventId, workerId:"worker-b", leaseToken:event.leaseToken,
      receipt:{ sink:"integration", event_id:event.eventId }
    }))
  ]);

  // Publish the earlier stable-id event so it cannot interfere with later exact batch assertions.
  await forceAvailable(stableId);
  const [stableLease] = await storeA.claimBatch({ tenantId, workerId:"worker-stable", batchSize:1, leaseMs:10_000 });
  assert.equal(stableLease.eventId, stableId);
  const stablePublished = await storeA.markPublished({
    tenantId, eventId:stableId, workerId:"worker-stable", leaseToken:stableLease.leaseToken,
    receipt:{ sink:"integration" }
  });
  const stablePublishedReplay = await storeB.markPublished({
    tenantId, eventId:stableId, workerId:"worker-stable", leaseToken:stableLease.leaseToken,
    receipt:{ sink:"ignored" }
  });
  assert.equal(stablePublished.replay, false);
  assert.equal(stablePublishedReplay.replay, true);

  const retryId = `evt-retry-${randomUUID()}`;
  await enqueue(storeA, retryId, { maxAttempts:4 });
  const [retryAttempt1] = await storeA.claimBatch({ tenantId, workerId:"worker-retry", batchSize:1, leaseMs:10_000 });
  assert.equal(retryAttempt1.eventId, retryId);
  const retry1 = await storeA.markFailed({
    tenantId, eventId:retryId, workerId:"worker-retry", leaseToken:retryAttempt1.leaseToken,
    error:Object.assign(new Error("transient one"), { code:"TRANSIENT_ONE" }),
    baseRetryMs:5_000, maxRetryMs:60_000
  });
  const firstDelay = retry1.retryDelayMs;
  assert.equal(retry1.status, "retry");
  assert.ok(firstDelay > 4_000 && firstDelay <= 5_100);
  await forceAvailable(retryId);
  const [retryAttempt2] = await storeB.claimBatch({ tenantId, workerId:"worker-retry-b", batchSize:1, leaseMs:10_000 });
  const retry2 = await storeB.markFailed({
    tenantId, eventId:retryId, workerId:"worker-retry-b", leaseToken:retryAttempt2.leaseToken,
    error:Object.assign(new Error("transient two"), { code:"TRANSIENT_TWO" }),
    baseRetryMs:5_000, maxRetryMs:60_000
  });
  const secondDelay = retry2.retryDelayMs;
  assert.equal(retry2.status, "retry");
  assert.ok(secondDelay > firstDelay * 1.8, `指数退避未增长: ${firstDelay} -> ${secondDelay}`);
  await forceAvailable(retryId);
  const [retryAttempt3] = await storeA.claimBatch({ tenantId, workerId:"worker-retry", batchSize:1, leaseMs:10_000 });
  await storeA.markPublished({
    tenantId, eventId:retryId, workerId:"worker-retry", leaseToken:retryAttempt3.leaseToken,
    receipt:{ attempt:retryAttempt3.attempt }
  });

  const deadId = `evt-dead-${randomUUID()}`;
  await enqueue(storeA, deadId, { maxAttempts:2 });
  const [deadAttempt1] = await storeA.claimBatch({ tenantId, workerId:"worker-dead", batchSize:1, leaseMs:10_000 });
  assert.equal((await storeA.markFailed({
    tenantId, eventId:deadId, workerId:"worker-dead", leaseToken:deadAttempt1.leaseToken,
    error:new Error("first failure"), baseRetryMs:10, maxRetryMs:100
  })).status, "retry");
  await forceAvailable(deadId);
  const [deadAttempt2] = await storeA.claimBatch({ tenantId, workerId:"worker-dead", batchSize:1, leaseMs:10_000 });
  const dead = await storeA.markFailed({
    tenantId, eventId:deadId, workerId:"worker-dead", leaseToken:deadAttempt2.leaseToken,
    error:new Error("second failure"), baseRetryMs:10, maxRetryMs:100
  });
  assert.equal(dead.status, "dead_letter");
  assert.ok(dead.deadLetteredAt);

  const permanentId = `evt-permanent-${randomUUID()}`;
  await enqueue(storeA, permanentId, { maxAttempts:8 });
  const [permanentLease] = await storeA.claimBatch({ tenantId, workerId:"worker-permanent", batchSize:1, leaseMs:10_000 });
  const permanent = await storeA.markFailed({
    tenantId, eventId:permanentId, workerId:"worker-permanent", leaseToken:permanentLease.leaseToken,
    error:Object.assign(new Error("invalid downstream contract"), { code:"OUTBOX_TARGET_HTTP_422" }),
    permanent:true
  });
  assert.equal(permanent.status, "dead_letter");
  assert.equal(permanent.attempt, 1);

  const leaseId = `evt-lease-${randomUUID()}`;
  await enqueue(storeA, leaseId, { maxAttempts:3 });
  const [oldLease] = await storeA.claimBatch({ tenantId, workerId:"worker-old", batchSize:1, leaseMs:10_000 });
  await databaseA.tenantQuery(
    tenantId,
    `UPDATE outbox_events
     SET locked_at=clock_timestamp() - interval '2 seconds',
         lease_expires_at=clock_timestamp() - interval '1 second'
     WHERE tenant_id=$1 AND event_id=$2`,
    [tenantId, leaseId]
  );
  await assert.rejects(
    storeA.markFailed({
      tenantId, eventId:leaseId, workerId:"worker-old", leaseToken:oldLease.leaseToken,
      error:new Error("late failure after lease expiry")
    }),
    (error) => error.code === "OUTBOX_LEASE_LOST"
  );
  const [recovered] = await storeB.claimBatch({ tenantId, workerId:"worker-new", batchSize:1, leaseMs:10_000 });
  assert.equal(recovered.eventId, leaseId);
  assert.equal(recovered.recoveredLease, true);
  assert.equal(recovered.attempt, 2);
  assert.notEqual(recovered.leaseToken, oldLease.leaseToken);
  await assert.rejects(
    storeA.markPublished({
      tenantId, eventId:leaseId, workerId:"worker-old", leaseToken:oldLease.leaseToken,
      receipt:{ stale:true }
    }),
    (error) => error.code === "OUTBOX_LEASE_LOST"
  );
  await storeB.markPublished({
    tenantId, eventId:leaseId, workerId:"worker-new", leaseToken:recovered.leaseToken,
    receipt:{ recovered:true }
  });

  const drainId = `evt-drain-${randomUUID()}`;
  await enqueue(storeA, drainId);
  let releasePublish;
  let deliveredContext;
  const worker = createPostgresOutboxWorker({
    store:storeA,
    tenantIds:[tenantId],
    workerId:"worker-drain",
    batchSize:1,
    maxInFlight:1,
    leaseMs:10_000,
    drainTimeoutMs:2_000,
    publish:(event, context) => new Promise((resolve) => {
      deliveredContext = { event, context };
      releasePublish = () => resolve({ sink:"drain-test", event_id:event.eventId });
    })
  });
  assert.equal(await worker.runOnce(), 1);
  assert.equal(deliveredContext.context.idempotencyKey, drainId);
  const stopping = worker.stop();
  releasePublish();
  const drain = await stopping;
  assert.equal(drain.drained, true);
  assert.equal(worker.inFlight, 0);

  const metrics = await storeA.metrics(tenantId);
  assert.equal(metrics.backlog, 0);
  assert.ok(metrics.published >= 24);
  assert.ok(metrics.deadLetter >= 1);
  assert.equal(metrics.expiredLeases, 0);
  assert.equal(typeof metrics.oldestBacklogSeconds, "number");

  console.log(`✓ PostgreSQL Outbox双worker互斥领取、event_id幂等、指数退避、死信、租约恢复、drain及积压指标通过（${tenantId}）`);
} finally {
  await migrationDatabase.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("DELETE FROM outbox_events WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM tenants WHERE tenant_id=$1", [tenantId]);
  }).catch(() => {});
  await Promise.allSettled([databaseA.close(), databaseB.close(), migrationDatabase.close()]);
}
