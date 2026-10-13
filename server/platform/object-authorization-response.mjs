// Object-level authorization must not reveal whether a guessed handover ID
// exists.  Keep this gateway response deliberately independent from the
// upstream policy/error wording.
const HIDDEN_HANDOVER_OBJECT_CODES = new Set([
  "HANDOVER_NOT_FOUND",
  "HANDOVER_ASSIGNMENT_FORBIDDEN",
  "HANDOVER_DEPARTMENT_FORBIDDEN",
  "HANDOVER_ASSIGNEE_MISMATCH",
  "CONTACT_REVEAL_ASSIGNEE_MISMATCH"
]);

const SAFE_HANDOVER_NOT_FOUND = Object.freeze({
  status:404,
  code:"HANDOVER_NOT_FOUND",
  message:"未找到指定接管任务"
});

export function safeHandoverObjectError(error) {
  return HIDDEN_HANDOVER_OBJECT_CODES.has(String(error?.code || ""))
    ? SAFE_HANDOVER_NOT_FOUND
    : null;
}
