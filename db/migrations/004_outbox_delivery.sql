BEGIN;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code varchar(96),
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_receipt jsonb;

UPDATE outbox_events
SET status = 'retry',
    available_at = clock_timestamp(),
    locked_at = NULL,
    locked_by = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = COALESCE(last_error, 'legacy processing row recovered during migration')
WHERE status = 'processing'
  AND (locked_at IS NULL OR locked_by IS NULL);

UPDATE outbox_events
SET locked_at = NULL,
    locked_by = NULL,
    lease_token = NULL,
    lease_expires_at = NULL
WHERE status <> 'processing'
  AND (locked_at IS NOT NULL OR locked_by IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL);

UPDATE outbox_events
SET lease_token = COALESCE(lease_token, gen_random_uuid()),
    lease_expires_at = COALESCE(lease_expires_at, locked_at + interval '60 seconds'),
    last_attempt_at = COALESCE(last_attempt_at, locked_at)
WHERE status = 'processing';

UPDATE outbox_events
SET dead_lettered_at = COALESCE(dead_lettered_at, updated_at)
WHERE status = 'dead_letter' AND dead_lettered_at IS NULL;

UPDATE outbox_events
SET delivery_receipt = NULL
WHERE delivery_receipt IS NOT NULL AND jsonb_typeof(delivery_receipt) <> 'object';

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_max_attempts_range,
  ADD CONSTRAINT outbox_events_max_attempts_range
    CHECK (max_attempts BETWEEN 1 AND 100),
  DROP CONSTRAINT IF EXISTS outbox_events_lease_state,
  ADD CONSTRAINT outbox_events_lease_state
    CHECK (
      (status = 'processing') =
      (locked_at IS NOT NULL AND locked_by IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  DROP CONSTRAINT IF EXISTS outbox_events_lease_order,
  ADD CONSTRAINT outbox_events_lease_order
    CHECK (lease_expires_at IS NULL OR locked_at IS NULL OR lease_expires_at > locked_at),
  DROP CONSTRAINT IF EXISTS outbox_events_published_pair,
  ADD CONSTRAINT outbox_events_published_pair
    CHECK ((status = 'published') = (published_at IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS outbox_events_dead_letter_pair,
  ADD CONSTRAINT outbox_events_dead_letter_pair
    CHECK ((status = 'dead_letter') = (dead_lettered_at IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS outbox_events_delivery_receipt_object,
  ADD CONSTRAINT outbox_events_delivery_receipt_object
    CHECK (delivery_receipt IS NULL OR jsonb_typeof(delivery_receipt) = 'object');

DROP INDEX IF EXISTS outbox_events_delivery_idx;
CREATE INDEX outbox_events_delivery_idx
  ON outbox_events (tenant_id, status, available_at, created_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS outbox_events_expired_lease_idx
  ON outbox_events (tenant_id, lease_expires_at, created_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS outbox_events_backlog_metrics_idx
  ON outbox_events (tenant_id, status, created_at);

COMMENT ON COLUMN outbox_events.event_id IS
  'Stable idempotency key. Downstream consumers must deduplicate by tenant_id + event_id.';
COMMENT ON COLUMN outbox_events.lease_token IS
  'Per-delivery fencing token; stale workers cannot acknowledge a subsequently reclaimed event.';
COMMENT ON COLUMN outbox_events.max_attempts IS
  'Maximum delivery claims, including claims recovered after lease expiry.';

COMMIT;
