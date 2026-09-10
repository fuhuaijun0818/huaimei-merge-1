export const POSTGRES_RUNTIME_TABLE_GRANT_GROUPS = Object.freeze([
  Object.freeze({
    privileges:Object.freeze(["SELECT", "INSERT", "UPDATE"]),
    tables:Object.freeze([
      "tenants", "conversation_sessions", "conversation_messages", "leads", "consents",
      "handovers", "tasks", "human_work", "outbox_events", "idempotency_records",
      "agent_runs", "data_subject_requests", "privacy_execution_actions", "contact_suppressions",
      "lead_candidates", "contact_vault_entries", "agent_turn_results", "agent_effect_ledger",
      "agent_turn_leases", "appointment_sessions", "knowledge_intake_state", "knowledge_intake_assets", "knowledge_publication_heads", "management_accounts"
    ])
  }),
  Object.freeze({
    privileges:Object.freeze(["SELECT", "INSERT"]),
    tables:Object.freeze(["audit_events", "privacy_identity_verifications", "privacy_completion_verifications", "knowledge_publication_packages", "knowledge_publication_events"])
  }),
  Object.freeze({
    privileges:Object.freeze(["SELECT"]),
    tables:Object.freeze(["data_migration_batches", "knowledge_releases", "knowledge_reviews"])
  })
]);

export const POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS = Object.freeze([
  "public.huamei_create_knowledge_release_draft(varchar,varchar,varchar,char,text[],char,varchar,jsonb,timestamptz,timestamptz,varchar)",
  "public.huamei_record_knowledge_review(varchar,varchar,varchar,varchar,varchar,varchar,text,jsonb,timestamptz)",
  "public.huamei_attach_knowledge_index(varchar,varchar,char,jsonb,varchar)",
  "public.huamei_activate_knowledge_release(varchar,varchar,varchar)"
]);

export const POSTGRES_RUNTIME_CALLABLE_FUNCTIONS = Object.freeze([
  "public.huamei_current_tenant()",
  "public.huamei_knowledge_review_scope_checksum(text,text,text,text,text,text)",
  ...POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS
]);

export const postgresRuntimeTablePrivilegeMap = () => new Map(
  POSTGRES_RUNTIME_TABLE_GRANT_GROUPS.flatMap((group) => group.tables.map((table) => [
    table,
    new Set(group.privileges)
  ]))
);
