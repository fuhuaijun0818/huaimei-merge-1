import assert from "node:assert/strict";
import { projectAppointmentsOntoCustomers } from "../server/appointment-customer-projection.mjs";

const customers = [{
  customer:{ id:"C-AI-ONE", timeline:[{ id:"lead-1", type:"conversation", occurredAt:"2026-10-12T08:00:00.000Z" }] },
  conversations:[{ externalConversationId:"session-1" }]
}];
const projected = projectAppointmentsOntoCustomers(customers, [{
  id:"apt_one", conversation_id:"session-1", appointment_no:"HMTESTONE", status:"registered", followup_status:"pending",
  version:2, time_preference:"2026-10-28 下午", updated_at:"2026-10-12T08:10:00.000Z", internal_customer_reference:"must-not-leave-server"
}]);
assert.equal(projected[0].customer.appointment.time_preference, "2026-10-28 下午");
assert.equal(projected[0].customer.appointment.version, 2);
assert.equal(projected[0].customer.timeline[0].type, "appointment");
assert.match(projected[0].customer.timeline[0].detail, /不代表指定医生或接诊名额已锁定/);
assert.doesNotMatch(JSON.stringify(projected), /must-not-leave-server/);
const cancelled = projectAppointmentsOntoCustomers(customers, [{
  id:"apt_cancelled", conversation_id:"session-1", appointment_no:"HMTESTCANCELLED", status:"cancelled", followup_status:"pending",
  version:3, time_preference:"2026-10-23 上午", updated_at:"2026-10-12T09:10:00.000Z"
}]);
assert.equal(cancelled[0].customer.appointment.status, "cancelled", "取消必须向客户 360 投影登记终态");
assert.equal(cancelled[0].customer.appointment.followup_status, "pending", "取消不篡改取消前的历史跟进状态");
assert.match(cancelled[0].customer.timeline[0].detail, /本次到院意向已取消/, "取消必须在客户时间线明确呈现");
assert.equal(projectAppointmentsOntoCustomers(customers, [])[0].customer.appointment, undefined);
console.log("✓ 到院登记按会话投影到客户360，且不暴露联系方式或内部引用");
