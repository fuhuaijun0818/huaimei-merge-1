BEGIN;

ALTER TABLE contact_vault_entries
  ALTER COLUMN ownership_verified_at DROP NOT NULL;

ALTER TABLE contact_vault_entries
  DROP CONSTRAINT IF EXISTS contact_vault_entries_ownership_verification_method_check;

ALTER TABLE contact_vault_entries
  ADD CONSTRAINT contact_vault_entries_ownership_verification_method_check
  CHECK (ownership_verification_method IN ('otp','verified_channel','development_bypass','format_validation'));

ALTER TABLE contact_vault_entries
  ADD COLUMN IF NOT EXISTS phone_verification_status varchar(24) NOT NULL DEFAULT 'verified'
  CHECK (phone_verification_status IN ('pending_manual','verified','invalid'));

UPDATE contact_vault_entries
SET phone_verification_status = CASE
  WHEN ownership_verification_method = 'format_validation' THEN 'pending_manual'
  ELSE 'verified'
END;

COMMENT ON COLUMN contact_vault_entries.phone_verification_status IS
  'Phone ownership state. New web captures are pending_manual until a sales consultant confirms the number during callback.';

COMMENT ON COLUMN contact_vault_entries.ownership_verified_at IS
  'Ownership verification time. NULL means the format-valid captured number is waiting for manual callback verification.';

COMMENT ON COLUMN contact_vault_entries.ownership_verification_id IS
  'Capture or ownership-verification receipt bound to one tenant-scoped vault entry; exact retries are idempotent.';

COMMENT ON TABLE contact_vault_entries IS
  'Tenant-scoped reversible contact vault. Format-valid numbers may be stored as pending_manual and disclosed only through the audited claimed-handover callback path.';

COMMIT;
