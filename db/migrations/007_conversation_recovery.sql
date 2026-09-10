BEGIN;

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS processing_state varchar(24),
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code varchar(96);

UPDATE conversation_messages
SET processing_state = metadata->>'processing_state',
    processing_attempts = 1,
    processing_deadline_at = CASE
      WHEN metadata->>'processing_state' = 'received'
      THEN coalesce((metadata->>'received_at')::timestamptz, created_at) + interval '2 minutes'
      ELSE NULL
    END,
    processing_completed_at = CASE
      WHEN metadata->>'processing_state' = 'completed'
      THEN coalesce((metadata->>'completed_at')::timestamptz, updated_at)
      ELSE NULL
    END,
    processing_failed_at = CASE
      WHEN metadata->>'processing_state' = 'failed'
      THEN coalesce((metadata->>'failed_at')::timestamptz, updated_at)
      ELSE NULL
    END,
    failure_code = CASE
      WHEN metadata->>'processing_state' = 'failed'
      THEN coalesce(nullif(metadata->>'failure_code', ''), 'LEGACY_PROCESSING_FAILURE')
      ELSE NULL
    END
WHERE role = 'user'
  AND direction = 'inbound'
  AND processing_state IS NULL
  AND metadata->>'processing_state' IN ('received', 'completed', 'failed');

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_processing_state_valid,
  ADD CONSTRAINT conversation_messages_processing_state_valid
    CHECK (processing_state IS NULL OR processing_state IN ('received', 'completed', 'failed')),
  DROP CONSTRAINT IF EXISTS conversation_messages_processing_scope,
  ADD CONSTRAINT conversation_messages_processing_scope
    CHECK (processing_state IS NULL OR (role = 'user' AND direction = 'inbound')),
  DROP CONSTRAINT IF EXISTS conversation_messages_processing_lifecycle,
  ADD CONSTRAINT conversation_messages_processing_lifecycle
    CHECK (
      (processing_state IS NULL AND processing_attempts = 0
        AND processing_deadline_at IS NULL
        AND processing_completed_at IS NULL
        AND processing_failed_at IS NULL
        AND failure_code IS NULL)
      OR
      (processing_state = 'received' AND processing_attempts >= 1
        AND processing_deadline_at IS NOT NULL
        AND processing_completed_at IS NULL
        AND processing_failed_at IS NULL
        AND failure_code IS NULL)
      OR
      (processing_state = 'completed' AND processing_attempts >= 1
        AND processing_deadline_at IS NULL
        AND processing_completed_at IS NOT NULL
        AND processing_failed_at IS NULL
        AND failure_code IS NULL)
      OR
      (processing_state = 'failed' AND processing_attempts >= 1
        AND processing_deadline_at IS NULL
        AND processing_completed_at IS NULL
        AND processing_failed_at IS NOT NULL
        AND failure_code IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS conversation_messages_stale_receipt_idx
  ON conversation_messages (tenant_id, processing_deadline_at, session_record_id, turn_sequence)
  WHERE processing_state = 'received';

CREATE INDEX IF NOT EXISTS conversation_messages_failed_receipt_idx
  ON conversation_messages (tenant_id, processing_failed_at, session_record_id, turn_sequence)
  WHERE processing_state = 'failed';

COMMENT ON COLUMN conversation_messages.processing_state IS
  'Durable inbound lifecycle. Failed receipts keep their sequence blocked until the same message id is replayed.';
COMMENT ON COLUMN conversation_messages.processing_deadline_at IS
  'Worker may fail the receipt after this deadline, but must never advance next_commit_sequence.';
COMMENT ON COLUMN conversation_messages.processing_attempts IS
  'Initial receipt plus explicit same-message replay recoveries after timeout failure.';

COMMIT;
