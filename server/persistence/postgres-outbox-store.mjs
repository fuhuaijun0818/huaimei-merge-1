import { createHash, randomUUID } from "node:crypto";

import { getPostgresClient } from "../platform/postgres.mjs";

const positiveInteger = (value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
};

const boundedText = (value, maximum, fallback = "") => {
  const normalized = String(value ?? fallback).trim();
  return normalized.slice(0, maximum);
};

const tenantIdFor = (value) => {
  const tenantId = boundedText(value, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(tenantId)) {
    const error = new Error("A valid tenant id is required for Outbox access");
    error.code = "OUTBOX_TENANT_REQUIRED";
    throw error;
  }
  return tenantId;
};

const workerIdFor = (value) => {
  const workerId = boundedText(value, 160);
  if (!workerId) {
    const error = new Error("A worker id is required for Outbox lease operations");
    error.code = "OUTBOX_WORKER_ID_REQUIRED";
    throw error;
  }
  return workerId;
};

const eventIdFor = (value) => {
  const eventId = boundedText(value, 160);
  if (!eventId) {
    const error = new Error("A stable event id is required");
    error.code = "OUTBOX_EVENT_ID_REQUIRED";
    throw error;
  }
  return eventId;
};

const leaseTokenFor = (value) => {
  const token = boundedText(value, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    const error = new Error("A valid Outbox lease token is required");
    error.code = "OUTBOX_LEASE_TOKEN_REQUIRED";
    throw error;
  }
  return token;
};

const jsonObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizedJsonObject = (value) => {
  try {
    return jsonObject(JSON.parse(JSON.stringify(jsonObject(value))));
  } catch (cause) {
    const error = new Error("Outbox payload and headers must be JSON serializable", { cause });
    error.code = "OUTBOX_EVENT_JSON_INVALID";
    throw error;
  }
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const semanticDigest = ({ aggregateType, aggregateId, eventType, payload, headers }) => createHash("sha256")
  .update(JSON.stringify(stableValue({ aggregateType, aggregateId, eventType, payload, headers })))
  .digest("hex");

const iso = (value) => value ? new Date(value).toISOString() : null;

const mapEvent = (row) => ({
  id:String(row.id),
  tenantId:String(row.tenant_id),
  eventId:String(row.event_id),
  aggregateType:String(row.aggregate_type),
  aggregateId:String(row.aggregate_id),
  eventType:String(row.event_type),
  payload:jsonObject(row.payload),
  headers:jsonObject(row.headers),
  status:String(row.status),
  attempt:Number(row.attempts),
  maxAttempts:Number(row.max_attempts),
  availableAt:iso(row.available_at),
  lockedAt:iso(row.locked_at),
  workerId:row.locked_by ? String(row.locked_by) : null,
  leaseToken:row.lease_token ? String(row.lease_token) : null,
  leaseExpiresAt:iso(row.lease_expires_at),
  lastErrorCode:row.last_error_code ? String(row.last_error_code) : null,
  lastError:row.last_error ? String(row.last_error) : null,
  createdAt:iso(row.created_at),
  recoveredLease:Boolean(row.recovered_lease)
});

const leaseLost = (eventId) => {
  const error = new Error(`Outbox lease is no longer owned for event ${eventId}`);
  error.code = "OUTBOX_LEASE_LOST";
  return error;
};

export function createPostgresOutboxStore(options = {}) {
  const postgres = options.postgres || getPostgresClient();
  if (!postgres || typeof postgres.tenantTransaction !== "function") {
    throw new TypeError("postgres must provide tenantTransaction()");
  }
  const defaultLeaseMs = positiveInteger(options.leaseMs, 30_000, 1_000, 15 * 60_000);
  const defaultBatchSize = positiveInteger(options.batchSize, 25, 1, 500);
  const defaultMaxAttempts = positiveInteger(options.maxAttempts, 8, 1, 100);
  const defaultBaseRetryMs = positiveInteger(options.baseRetryMs, 1_000, 10, 60 * 60_000);
  const defaultMaxRetryMs = positiveInteger(options.maxRetryMs, 5 * 60_000, 10, 24 * 60 * 60_000);

  const enqueue = async ({
    tenantId:tenantValue,
    eventId:eventValue = `outbox_${randomUUID()}`,
    aggregateType,
    aggregateId,
    eventType,
    payload = {},
    headers = {},
    maxAttempts = defaultMaxAttempts,
    availableAt = null
  }) => {
    const tenantId = tenantIdFor(tenantValue);
    const eventId = eventIdFor(eventValue);
    const normalized = {
      aggregateType:boundedText(aggregateType, 80),
      aggregateId:boundedText(aggregateId, 160),
      eventType:boundedText(eventType, 128),
      payload:normalizedJsonObject(payload),
      headers:normalizedJsonObject(headers)
    };
    if (!normalized.aggregateType || !normalized.aggregateId || !normalized.eventType) {
      const error = new Error("aggregateType, aggregateId and eventType are required");
      error.code = "OUTBOX_EVENT_INVALID";
      throw error;
    }
    const attemptsLimit = positiveInteger(maxAttempts, defaultMaxAttempts, 1, 100);
    return postgres.tenantTransaction(tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO outbox_events
          (tenant_id, event_id, aggregate_type, aggregate_id, event_type,
           payload, headers, max_attempts, available_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,COALESCE($9::timestamptz, clock_timestamp()))
         ON CONFLICT (tenant_id, event_id) DO NOTHING
         RETURNING *`,
        [tenantId, eventId, normalized.aggregateType, normalized.aggregateId, normalized.eventType,
          JSON.stringify(normalized.payload), JSON.stringify(normalized.headers), attemptsLimit, availableAt]
      );
      if (inserted.rowCount) return { event:mapEvent(inserted.rows[0]), replay:false };
      const existing = await client.query(
        `SELECT * FROM outbox_events WHERE tenant_id=$1 AND event_id=$2`,
        [tenantId, eventId]
      );
      if (!existing.rowCount) throw leaseLost(eventId);
      const row = existing.rows[0];
      const existingDigest = semanticDigest({
        aggregateType:row.aggregate_type,
        aggregateId:row.aggregate_id,
        eventType:row.event_type,
        payload:jsonObject(row.payload),
        headers:jsonObject(row.headers)
      });
      if (existingDigest !== semanticDigest(normalized)) {
        const error = new Error(`Outbox event id ${eventId} was reused with different content`);
        error.code = "OUTBOX_EVENT_ID_CONFLICT";
        throw error;
      }
      return { event:mapEvent(row), replay:true };
    });
  };

  const claimBatch = async ({
    tenantId:tenantValue,
    workerId:workerValue,
    batchSize = defaultBatchSize,
    leaseMs = defaultLeaseMs
  }) => {
    const tenantId = tenantIdFor(tenantValue);
    const workerId = workerIdFor(workerValue);
    const take = positiveInteger(batchSize, defaultBatchSize, 1, 500);
    const lease = positiveInteger(leaseMs, defaultLeaseMs, 1_000, 15 * 60_000);
    return postgres.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE outbox_events
         SET status='dead_letter',
             dead_lettered_at=clock_timestamp(),
             available_at=clock_timestamp(),
             locked_at=NULL,
             locked_by=NULL,
             lease_token=NULL,
             lease_expires_at=NULL,
             last_error_code=COALESCE(last_error_code, 'OUTBOX_ATTEMPTS_EXHAUSTED'),
             last_error=COALESCE(last_error, 'Delivery attempts exhausted before a new lease could be granted')
         WHERE tenant_id=$1
           AND attempts >= max_attempts
           AND (
             (status IN ('pending','retry') AND available_at <= clock_timestamp())
             OR (status='processing' AND lease_expires_at <= clock_timestamp())
           )`,
        [tenantId]
      );
      const claimed = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT id, (status='processing') AS recovered_lease
           FROM outbox_events
           WHERE tenant_id=$1
             AND attempts < max_attempts
             AND (
               (status IN ('pending','retry') AND available_at <= clock_timestamp())
               OR (status='processing' AND lease_expires_at <= clock_timestamp())
             )
           ORDER BY
             CASE WHEN status='processing' THEN lease_expires_at ELSE available_at END,
             created_at,
             id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE outbox_events AS event
         SET status='processing',
             attempts=event.attempts + 1,
             locked_at=clock_timestamp(),
             locked_by=$3,
             lease_token=gen_random_uuid(),
             lease_expires_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             last_attempt_at=clock_timestamp(),
             dead_lettered_at=NULL,
             last_error_code=CASE WHEN candidates.recovered_lease THEN 'OUTBOX_LEASE_EXPIRED' ELSE event.last_error_code END,
             last_error=CASE WHEN candidates.recovered_lease THEN 'Previous delivery lease expired before acknowledgement' ELSE event.last_error END
         FROM candidates
         WHERE event.id=candidates.id
         RETURNING event.*, candidates.recovered_lease`,
        [tenantId, take, workerId, lease]
      );
      return claimed.rows.map(mapEvent);
    });
  };

  const renewLease = async ({ tenantId:tenantValue, eventId:eventValue, workerId:workerValue, leaseToken, leaseMs = defaultLeaseMs }) => {
    const tenantId = tenantIdFor(tenantValue);
    const eventId = eventIdFor(eventValue);
    const workerId = workerIdFor(workerValue);
    const token = leaseTokenFor(leaseToken);
    const lease = positiveInteger(leaseMs, defaultLeaseMs, 1_000, 15 * 60_000);
    const result = await postgres.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE outbox_events
       SET lease_expires_at=clock_timestamp() + ($5::bigint * interval '1 millisecond')
       WHERE tenant_id=$1 AND event_id=$2 AND status='processing'
         AND locked_by=$3 AND lease_token=$4::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING lease_expires_at`,
      [tenantId, eventId, workerId, token, lease]
    ));
    if (!result.rowCount) throw leaseLost(eventId);
    return { eventId, leaseExpiresAt:iso(result.rows[0].lease_expires_at) };
  };

  const markPublished = async ({
    tenantId:tenantValue,
    eventId:eventValue,
    workerId:workerValue,
    leaseToken,
    receipt = {}
  }) => {
    const tenantId = tenantIdFor(tenantValue);
    const eventId = eventIdFor(eventValue);
    const workerId = workerIdFor(workerValue);
    const token = leaseTokenFor(leaseToken);
    return postgres.tenantTransaction(tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE outbox_events
         SET status='published',
             published_at=clock_timestamp(),
             delivery_receipt=$5::jsonb,
             locked_at=NULL,
             locked_by=NULL,
             lease_token=NULL,
             lease_expires_at=NULL,
             last_error_code=NULL,
             last_error=NULL
         WHERE tenant_id=$1 AND event_id=$2 AND status='processing'
           AND locked_by=$3 AND lease_token=$4::uuid
           AND lease_expires_at > clock_timestamp()
         RETURNING published_at, delivery_receipt`,
        [tenantId, eventId, workerId, token, JSON.stringify(jsonObject(receipt))]
      );
      if (updated.rowCount) {
        return { eventId, status:"published", replay:false, publishedAt:iso(updated.rows[0].published_at), receipt:jsonObject(updated.rows[0].delivery_receipt) };
      }
      const existing = await client.query(
        `SELECT status, published_at, delivery_receipt FROM outbox_events WHERE tenant_id=$1 AND event_id=$2`,
        [tenantId, eventId]
      );
      if (existing.rows[0]?.status === "published") {
        return {
          eventId,
          status:"published",
          replay:true,
          publishedAt:iso(existing.rows[0].published_at),
          receipt:jsonObject(existing.rows[0].delivery_receipt)
        };
      }
      throw leaseLost(eventId);
    });
  };

  const markFailed = async ({
    tenantId:tenantValue,
    eventId:eventValue,
    workerId:workerValue,
    leaseToken,
    error,
    permanent = false,
    baseRetryMs = defaultBaseRetryMs,
    maxRetryMs = defaultMaxRetryMs
  }) => {
    const tenantId = tenantIdFor(tenantValue);
    const eventId = eventIdFor(eventValue);
    const workerId = workerIdFor(workerValue);
    const token = leaseTokenFor(leaseToken);
    const baseDelay = positiveInteger(baseRetryMs, defaultBaseRetryMs, 10, 60 * 60_000);
    const delayCap = positiveInteger(maxRetryMs, defaultMaxRetryMs, baseDelay, 24 * 60 * 60_000);
    const errorCode = boundedText(error?.code || "OUTBOX_DELIVERY_FAILED", 96, "OUTBOX_DELIVERY_FAILED");
    const errorMessage = boundedText(error?.message || "Outbox delivery failed", 1000, "Outbox delivery failed");
    const result = await postgres.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE outbox_events
       SET status=CASE WHEN $9::boolean OR attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
           available_at=CASE
             WHEN $9::boolean OR attempts >= max_attempts THEN clock_timestamp()
             ELSE clock_timestamp() + (
               LEAST($7::numeric, $6::numeric * power(2::numeric, GREATEST(attempts - 1, 0)))
               * interval '1 millisecond'
             )
           END,
           dead_lettered_at=CASE WHEN $9::boolean OR attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
           locked_at=NULL,
           locked_by=NULL,
           lease_token=NULL,
           lease_expires_at=NULL,
           last_error_code=$5,
           last_error=$8
       WHERE tenant_id=$1 AND event_id=$2 AND status='processing'
         AND locked_by=$3 AND lease_token=$4::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING status, attempts, max_attempts, available_at, dead_lettered_at,
         GREATEST(0, EXTRACT(epoch FROM (available_at - clock_timestamp())) * 1000)::double precision AS retry_delay_ms`,
      [tenantId, eventId, workerId, token, errorCode, baseDelay, delayCap, errorMessage, Boolean(permanent)]
    ));
    if (!result.rowCount) throw leaseLost(eventId);
    const row = result.rows[0];
    return {
      eventId,
      status:String(row.status),
      attempt:Number(row.attempts),
      maxAttempts:Number(row.max_attempts),
      retryDelayMs:Number(Number(row.retry_delay_ms || 0).toFixed(3)),
      availableAt:iso(row.available_at),
      deadLetteredAt:iso(row.dead_lettered_at)
    };
  };

  const releaseLease = async ({ tenantId:tenantValue, eventId:eventValue, workerId:workerValue, leaseToken, reason = "worker shutdown" }) => {
    const tenantId = tenantIdFor(tenantValue);
    const eventId = eventIdFor(eventValue);
    const workerId = workerIdFor(workerValue);
    const token = leaseTokenFor(leaseToken);
    const result = await postgres.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE outbox_events
       SET status=CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
           available_at=clock_timestamp(),
           dead_lettered_at=CASE WHEN attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
           locked_at=NULL,
           locked_by=NULL,
           lease_token=NULL,
           lease_expires_at=NULL,
           last_error_code='OUTBOX_LEASE_RELEASED',
           last_error=$5
       WHERE tenant_id=$1 AND event_id=$2 AND status='processing'
         AND locked_by=$3 AND lease_token=$4::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING status`,
      [tenantId, eventId, workerId, token, boundedText(reason, 1000, "worker shutdown")]
    ));
    if (!result.rowCount) throw leaseLost(eventId);
    return { eventId, status:String(result.rows[0].status) };
  };

  const metrics = async (tenantValue) => {
    const tenantId = tenantIdFor(tenantValue);
    const result = await postgres.tenantQuery(
      tenantId,
      `SELECT
         count(*) FILTER (WHERE status='pending')::int AS pending,
         count(*) FILTER (WHERE status='retry')::int AS retry,
         count(*) FILTER (WHERE status='processing')::int AS processing,
         count(*) FILTER (WHERE status='published')::int AS published,
         count(*) FILTER (WHERE status='dead_letter')::int AS dead_letter,
         count(*) FILTER (WHERE status IN ('pending','retry') AND available_at <= clock_timestamp())::int AS ready,
         count(*) FILTER (WHERE status='processing' AND lease_expires_at <= clock_timestamp())::int AS expired_leases,
         COALESCE(EXTRACT(epoch FROM (clock_timestamp() - min(created_at) FILTER (
           WHERE status IN ('pending','retry','processing')
         ))), 0)::double precision AS oldest_backlog_seconds,
         min(created_at) FILTER (WHERE status IN ('pending','retry','processing')) AS oldest_backlog_at,
         min(available_at) FILTER (WHERE status IN ('pending','retry')) AS next_available_at
       FROM outbox_events
       WHERE tenant_id=$1`,
      [tenantId]
    );
    const row = result.rows[0];
    return {
      tenantId,
      pending:Number(row.pending),
      retry:Number(row.retry),
      processing:Number(row.processing),
      published:Number(row.published),
      deadLetter:Number(row.dead_letter),
      ready:Number(row.ready),
      expiredLeases:Number(row.expired_leases),
      backlog:Number(row.pending) + Number(row.retry) + Number(row.processing),
      oldestBacklogSeconds:Number(Number(row.oldest_backlog_seconds || 0).toFixed(3)),
      oldestBacklogAt:iso(row.oldest_backlog_at),
      nextAvailableAt:iso(row.next_available_at)
    };
  };

  return {
    driver:"postgres-outbox",
    enqueue,
    claimBatch,
    renewLease,
    markPublished,
    markFailed,
    releaseLease,
    metrics
  };
}
