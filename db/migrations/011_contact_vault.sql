BEGIN;

CREATE TABLE IF NOT EXISTS contact_vault_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  contact_reference varchar(160) NOT NULL,
  lead_record_id uuid NOT NULL,
  subject_reference_hmac char(64) NOT NULL
    CHECK (subject_reference_hmac ~ '^[0-9a-f]{64}$'),
  contact_type varchar(24) NOT NULL DEFAULT 'mobile'
    CHECK (contact_type = 'mobile'),
  purpose varchar(32) NOT NULL DEFAULT 'service_callback'
    CHECK (purpose = 'service_callback'),
  encrypted_value jsonb NOT NULL
    CHECK (
      jsonb_typeof(encrypted_value) = 'object'
      AND encrypted_value->>'_encrypted' = 'huamei.contact-vault.a256gcm.v1'
      AND encrypted_value->>'algorithm' = 'A256GCM'
      AND encrypted_value->>'kind' = 'mobile'
      AND encrypted_value ? 'key_id'
      AND encrypted_value ? 'iv'
      AND encrypted_value ? 'tag'
      AND encrypted_value ? 'ciphertext'
      AND jsonb_typeof(encrypted_value->'wrapped_data_key') = 'object'
      AND encrypted_value->'wrapped_data_key'->>'algorithm' = 'A256GCM'
      AND encrypted_value->'wrapped_data_key'->>'kind' = 'data_key'
      AND encrypted_value->'wrapped_data_key' ? 'iv'
      AND encrypted_value->'wrapped_data_key' ? 'tag'
      AND encrypted_value->'wrapped_data_key' ? 'ciphertext'
      AND NOT (encrypted_value ?| ARRAY['value','mobile','phone','plaintext'])
      AND NOT ((encrypted_value->'wrapped_data_key') ?| ARRAY['value','mobile','phone','plaintext','key'])
    ),
  masked_value varchar(32) NOT NULL
    CHECK (masked_value ~ '^1[3-9][0-9]\*{4}[0-9]{4}$'),
  encryption_key_id varchar(64) NOT NULL
    CHECK (encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ownership_verification_id varchar(160) NOT NULL,
  ownership_verification_method varchar(32) NOT NULL
    CHECK (ownership_verification_method IN ('otp','verified_channel','development_bypass')),
  ownership_verified_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','erased')),
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contact_vault_entries_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT contact_vault_entries_business_key UNIQUE (tenant_id, contact_reference),
  CONSTRAINT contact_vault_entries_lead_type_unique UNIQUE (tenant_id, lead_record_id, contact_type),
  CONSTRAINT contact_vault_entries_verification_unique UNIQUE (tenant_id, ownership_verification_id),
  CONSTRAINT contact_vault_entries_lead_fk
    FOREIGN KEY (tenant_id, lead_record_id)
    REFERENCES leads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT contact_vault_entries_erasure_state CHECK (
    (status = 'active' AND erased_at IS NULL)
    OR (status = 'erased' AND erased_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS contact_vault_entries_subject_idx
  ON contact_vault_entries (tenant_id, subject_reference_hmac, status, updated_at);
CREATE INDEX IF NOT EXISTS contact_vault_entries_lead_idx
  ON contact_vault_entries (tenant_id, lead_record_id, status);

DROP TRIGGER IF EXISTS contact_vault_entries_set_updated_at ON contact_vault_entries;
CREATE TRIGGER contact_vault_entries_set_updated_at BEFORE UPDATE ON contact_vault_entries
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

ALTER TABLE contact_vault_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_vault_entries;
CREATE POLICY tenant_isolation ON contact_vault_entries
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE contact_vault_entries FORCE ROW LEVEL SECURITY;

REVOKE ALL ON contact_vault_entries FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT, UPDATE ON contact_vault_entries TO huamei_runtime;

COMMENT ON TABLE contact_vault_entries IS
  'Tenant-scoped reversible contact vault. Values are always independently AES-256-GCM encrypted and are disclosed only through the audited claimed-handover reveal path.';
COMMENT ON COLUMN contact_vault_entries.encrypted_value IS
  'Dedicated envelope encryption: a per-write random AES-256-GCM data key encrypts the contact, and the independent contact keyring wraps that data key. Plaintext values and keys are forbidden.';
COMMENT ON COLUMN contact_vault_entries.ownership_verification_id IS
  'One ownership-verification receipt may bind only one tenant-scoped vault entry; exact retries are idempotent.';

COMMIT;
