import assert from "node:assert/strict";
import { safeHandoverObjectError } from "../server/platform/object-authorization-response.mjs";

for (const code of [
  "HANDOVER_NOT_FOUND",
  "HANDOVER_ASSIGNMENT_FORBIDDEN",
  "HANDOVER_DEPARTMENT_FORBIDDEN",
  "HANDOVER_ASSIGNEE_MISMATCH",
  "CONTACT_REVEAL_ASSIGNEE_MISMATCH"
]) {
  assert.deepEqual(
    safeHandoverObjectError({ code, message:"upstream detail must not leak" }),
    { status:404, code:"HANDOVER_NOT_FOUND", message:"未找到指定接管任务" },
    `${code} must have the same external response as a missing handover`
  );
}

assert.equal(safeHandoverObjectError({ code:"HANDOVER_ALREADY_CLAIMED" }), null, "state conflicts remain visible to an otherwise authorized caller");
assert.equal(safeHandoverObjectError({ code:"ACQUISITION_SERVICE_UNAVAILABLE" }), null, "availability errors must not masquerade as not-found");
console.log("✓ 接管对象的无权与不存在响应已统一，状态冲突和服务故障未被掩盖");
