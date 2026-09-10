BEGIN;

ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS next_turn_sequence bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS next_commit_sequence bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;

ALTER TABLE conversation_sessions
  DROP CONSTRAINT IF EXISTS conversation_sessions_sequence_range,
  ADD CONSTRAINT conversation_sessions_sequence_range
    CHECK (
      next_turn_sequence >= 1
      AND next_commit_sequence >= 1
      AND next_commit_sequence <= next_turn_sequence
      AND state_version >= 0
    );

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS turn_sequence bigint,
  ADD COLUMN IF NOT EXISTS parent_message_id varchar(160);

-- Preserve the chronology of rows written before this migration. The legacy
-- writer inserted one inbound and one assistant row per turn, so independently
-- ranking both directions reconstructs their shared turn number without
-- rewriting the externally visible message ids.
WITH ordered_inbound AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY tenant_id, session_record_id
      ORDER BY occurred_at, created_at, id
    ) AS turn_sequence
  FROM conversation_messages
  WHERE role = 'user' AND direction = 'inbound' AND turn_sequence IS NULL
)
UPDATE conversation_messages AS message
SET turn_sequence = ordered.turn_sequence
FROM ordered_inbound AS ordered
WHERE message.id = ordered.id;

WITH ordered_inbound AS (
  SELECT tenant_id, session_record_id, message_id,
    row_number() OVER (
      PARTITION BY tenant_id, session_record_id
      ORDER BY occurred_at, created_at, id
    ) AS turn_sequence
  FROM conversation_messages
  WHERE role = 'user' AND direction = 'inbound'
), ordered_assistant AS (
  SELECT id, tenant_id, session_record_id,
    row_number() OVER (
      PARTITION BY tenant_id, session_record_id
      ORDER BY occurred_at, created_at, id
    ) AS turn_sequence
  FROM conversation_messages
  WHERE role = 'assistant' AND direction = 'outbound' AND turn_sequence IS NULL
)
UPDATE conversation_messages AS assistant
SET turn_sequence = ordered.turn_sequence,
    parent_message_id = inbound.message_id
FROM ordered_assistant AS ordered
LEFT JOIN ordered_inbound AS inbound
  ON inbound.tenant_id = ordered.tenant_id
 AND inbound.session_record_id = ordered.session_record_id
 AND inbound.turn_sequence = ordered.turn_sequence
WHERE assistant.id = ordered.id;

WITH session_maxima AS (
  SELECT tenant_id, session_record_id,
    coalesce(max(turn_sequence), 0) + 1 AS next_sequence
  FROM conversation_messages
  WHERE role = 'user' AND direction = 'inbound'
  GROUP BY tenant_id, session_record_id
)
UPDATE conversation_sessions AS session
SET next_turn_sequence = maxima.next_sequence,
    next_commit_sequence = maxima.next_sequence
FROM session_maxima AS maxima
WHERE session.tenant_id = maxima.tenant_id
  AND session.id = maxima.session_record_id
  AND session.next_turn_sequence = 1
  AND session.next_commit_sequence = 1;

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_turn_sequence_positive,
  ADD CONSTRAINT conversation_messages_turn_sequence_positive
    CHECK (turn_sequence IS NULL OR turn_sequence >= 1),
  DROP CONSTRAINT IF EXISTS conversation_messages_parent_fk,
  ADD CONSTRAINT conversation_messages_parent_fk
    FOREIGN KEY (tenant_id, session_record_id, parent_message_id)
    REFERENCES conversation_messages(tenant_id, session_record_id, message_id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_inbound_sequence_unique
  ON conversation_messages (tenant_id, session_record_id, turn_sequence)
  WHERE turn_sequence IS NOT NULL AND role = 'user' AND direction = 'inbound';

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_assistant_sequence_unique
  ON conversation_messages (tenant_id, session_record_id, turn_sequence)
  WHERE turn_sequence IS NOT NULL AND role = 'assistant' AND direction = 'outbound';

CREATE INDEX IF NOT EXISTS conversation_messages_parent_idx
  ON conversation_messages (tenant_id, session_record_id, parent_message_id)
  WHERE parent_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_messages_ordered_timeline_idx
  ON conversation_messages (tenant_id, session_record_id, turn_sequence, direction, id)
  WHERE turn_sequence IS NOT NULL;

COMMENT ON COLUMN conversation_sessions.next_turn_sequence IS
  'Next sequence reserved when a channel inbound message is durably received.';
COMMENT ON COLUMN conversation_sessions.next_commit_sequence IS
  'Only this sequence may mutate conversation state and emit its assistant reply.';
COMMENT ON COLUMN conversation_sessions.state_version IS
  'Monotonic version incremented for every durable session-state mutation.';
COMMENT ON COLUMN conversation_messages.turn_sequence IS
  'Conversation-local receipt order. User and derived assistant messages share one sequence.';
COMMENT ON COLUMN conversation_messages.parent_message_id IS
  'Inbound business message id that deterministically owns this assistant reply.';

COMMIT;
