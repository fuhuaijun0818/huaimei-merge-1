import assert from "node:assert/strict";

import {
  containsContactPii,
  redactContactPii,
  redactContactPiiDeep
} from "../server/platform/contact-pii-redaction.mjs";

const mobile = "13876543210";
const variants = [
  mobile,
  "138-7654-3210",
  "138 7654 3210",
  "+86 138 7654 3210",
  "+86 (138) 7654-3210",
  "(138)76543210",
  "（138） 7654-3210",
  "0086-138-7654-3210",
  "138—7654—3210"
];

for (const variant of variants) {
  const source = `请转人工，电话${variant}，谢谢`;
  assert.equal(redactContactPii(source), "请转人工，电话138****3210，谢谢", `未脱敏: ${variant}`);
  assert.equal(containsContactPii(source), true, `未识别: ${variant}`);
  assert.equal(
    redactContactPii(source, { replacement:"[mobile-redacted]" }),
    "请转人工，电话[mobile-redacted]，谢谢"
  );
}

for (const ordinary of [
  "订单号12345678901",
  "十二位编号138765432101",
  "编号9-138-7654-3210",
  "编号138-7654-3210-9",
  "预算13876元",
  "日期20260826138"
]) {
  assert.equal(redactContactPii(ordinary), ordinary, `普通数字被误伤: ${ordinary}`);
  assert.equal(containsContactPii(ordinary), false);
}

const deep = redactContactPiiDeep({
  summary:"请回拨+86 138 7654 3210",
  nested:[{ note:"备用(138)76543210" }],
  count:138
}, { replacement:"[mobile-redacted]" });
assert.deepEqual(deep, {
  summary:"请回拨[mobile-redacted]",
  nested:[{ note:"备用[mobile-redacted]" }],
  count:138
});

console.log("✓ 统一联系方式PII脱敏覆盖+86、空格、连字符、括号及普通数字防误伤");
