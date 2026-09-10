// Display only normalized server results. A duplicate customer is not implicitly
// a member, and a provider/configuration failure is never a non-member result.
export function memberCheckPresentation(check) {
  if (!check || check.schema !== "huamei.member-repeatcheck.v1") return { label:"尚未核验", tone:"outline", checkedAt:null };
  if (check.status === "pending") return {label:"手机号已保存，院方查询待完成",tone:"warning",checkedAt:null};
  if (check.status === "not_configured") return { label:"待接入院方接口", tone:"warning", checkedAt:null };
  if (check.status === "capture_required") return { label:"手机号尚未有效保存", tone:"warning", checkedAt:null };
  if (check.status === "failed" && check.reason_code === "PROVIDER_SIGNATURE_REQUIRED") return {label:"手机号已保存；院方接口验签配置待确认",tone:"warning",checkedAt:null};
  if (check.status !== "checked" || typeof check.is_repeat !== "boolean" || !Number.isFinite(Date.parse(check.checked_at))) {
    return { label:"核验未完成，待重试", tone:"warning", checkedAt:null };
  }
  const label = check.result_semantics === "membership"
    ? (check.is_repeat ? "已核验：会员" : "已核验：非会员")
    : (check.is_repeat ? "院方已有客户记录" : "院方未找到客户记录");
  return { label, tone:"outline", checkedAt:check.checked_at };
}
