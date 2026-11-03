export const SELF_ASSESSMENT_AREAS = Object.freeze([
  { key:"eyes", label:"眼部", hint:"眼型、眼周状态等个人关注" },
  { key:"ears", label:"耳部", hint:"耳廓或耳部相关外观的个人关注" },
  { key:"nose", label:"鼻部", hint:"鼻型或鼻部区域的个人关注" },
  { key:"mouth", label:"口唇", hint:"唇形、口周状态等个人关注" },
  { key:"symmetry", label:"轮廓与对称", hint:"对自己面部轮廓或左右差异的感受" },
  { key:"skin_tone", label:"肤色与光暗", hint:"对自己肤色、明暗感受的描述" }
]);

export const SELF_ASSESSMENT_SCALE = Object.freeze([
  { value:1, label:"不在意" },
  { value:2, label:"一点点" },
  { value:3, label:"一般" },
  { value:4, label:"比较关注" },
  { value:5, label:"很关注" }
]);

export const SELF_ASSESSMENT_DISCLOSURE = "以下内容仅代表您主动表达的个人关注，不是根据照片推断五官、对称、肤色或皮肤状态，也不构成医疗判断。";

export function buildSelfAssessmentQuestion(ratings = {}, note = "") {
  const selected = SELF_ASSESSMENT_AREAS
    .map((area) => ({ ...area, value:Math.max(0, Math.min(5, Math.round(Number(ratings[area.key]) || 0))) }))
    .filter((area) => area.value > 0);
  if (!selected.length) return "";
  const scaleLabel = (value) => SELF_ASSESSMENT_SCALE.find((item) => item.value === value)?.label || "";
  const lines = selected.map((area) => `${area.label}：${scaleLabel(area.value)}（${area.value}/5）`);
  const extra = String(note || "").normalize("NFKC").trim().slice(0, 300);
  return [
    "这是我的个人关注自评，仅代表我自己的感受，不是照片分析：",
    ...lines,
    ...(extra ? [`补充说明：${extra}`] : []),
    "请先介绍这些关注点常见的项目方向与一般区别；是否适合及具体方案，请引导我到院面诊确认。"
  ].join("\n");
}
