const rawRuntime = typeof window === "object" && window.__HUAMEI_MANAGEMENT_RUNTIME__
  ? window.__HUAMEI_MANAGEMENT_RUNTIME__
  : null;

const recognizedSchema = rawRuntime?.schema === "huamei.management-runtime.v1";

export const managementRuntime = Object.freeze({
  // Missing or malformed runtime configuration fails closed. The server-owned
  // script is loaded before the module in supported deployments.
  deliveryMode:recognizedSchema && ["demo", "local_server"].includes(rawRuntime.delivery_mode)
    ? rawRuntime.delivery_mode
    : "handover_only",
  demoMutationsEnabled:recognizedSchema
    && rawRuntime.delivery_mode === "demo"
    && rawRuntime.demo_mutations_enabled === true,
  managementDomainEnabled:recognizedSchema
    && rawRuntime.delivery_mode === "local_server"
    && rawRuntime.management_domain_enabled === true,
  knowledgeGovernanceEnabled:recognizedSchema
    && rawRuntime.knowledge_governance_enabled === true,
  knowledgeIntakeEnabled:recognizedSchema
    && rawRuntime.knowledge_intake_enabled === true
});

export const handoverOnlyMode = managementRuntime.deliveryMode === "handover_only";
export const managementDomainEnabled = managementRuntime.managementDomainEnabled;
export const knowledgeGovernanceEnabled = managementRuntime.knowledgeGovernanceEnabled;
export const knowledgeIntakeEnabled = managementRuntime.knowledgeIntakeEnabled;

export const realManagementActions = new Set([
  "claim-handover",
  "complete-handover",
  "reveal-contact",
  "modal-backdrop",
  "modal-close",
  "notifications",
  "refresh",
  "refresh-handovers",
  "refresh-bad-cases",
  "view-bad-case",
  "review-bad-case",
  "refresh-knowledge-governance",
  "refresh-knowledge-intake",
  "clear-knowledge-intake-filters",
  "new-knowledge-intake",
  "edit-knowledge-intake",
  "confirm-knowledge-intake",
  "candidate-knowledge-intake",
  "refresh-appointments",
  "claim-appointment",
  "resolve-appointment",
  "new-schedule-slot"
]);
