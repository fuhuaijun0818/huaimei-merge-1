// 回滚前的“差异与影响”计算：纯函数，便于单元回归，也便于弹窗直接渲染。
// 只读取服务端已下发的发布包投影（id/文档清单/文本块数/active），不猜测未返回的字段。

const asDocuments = (value) => (Array.isArray(value) ? value : []).map((document) => ({
  id:String(document?.id || ""),
  title:String(document?.title || document?.id || "未命名资料"),
  version:Number(document?.version) || 0,
  department:String(document?.department || ""),
  expires_at:document?.expires_at || null
})).filter((document) => document.id);

const packageSummary = (pkg) => (pkg ? {
  id:String(pkg.id || ""),
  chunk_count:Number(pkg.chunk_count) || 0,
  document_count:asDocuments(pkg.documents).length,
  checksum:String(pkg.checksum || "")
} : null);

const uniqueDepartments = (documents) => [...new Set(documents.map((document) => document.department).filter(Boolean))];

export const summarizePublicationRollback = ({ current = null, target = null } = {}) => {
  const targetDocuments = asDocuments(target?.documents);
  const currentDocuments = asDocuments(current?.documents);
  const currentById = new Map(currentDocuments.map((document) => [document.id, document]));
  const targetById = new Map(targetDocuments.map((document) => [document.id, document]));

  const added = [];
  const unchanged = [];
  const version_changed = [];
  for (const document of targetDocuments) {
    const existing = currentById.get(document.id);
    if (!existing) added.push(document);
    else if (existing.version !== document.version) version_changed.push({ ...document, from_version:existing.version, to_version:document.version });
    else unchanged.push(document);
  }
  const removed = currentDocuments.filter((document) => !targetById.has(document.id));

  const has_current = Boolean(current?.id);
  const same_package = has_current && current.id === target?.id;
  const affected_documents = [...added, ...version_changed, ...removed];
  // 科室按目标包资料顺序排列，再补上回滚后停用资料所属科室，保证展示顺序稳定。
  const departments = uniqueDepartments([...targetDocuments, ...removed]);

  let impact;
  if (!target?.id) impact = "目标包信息缺失，无法计算回滚影响，请刷新后重试。";
  else if (!has_current) impact = "当前没有对客启用版本；回滚后对客检索将直接启用目标包内的全部资料。";
  else if (same_package) impact = "目标包就是当前启用版本，执行后有效版本与内容不变，仅重新写入一次发布事件。";
  else if (!affected_documents.length) impact = "两个包的资料与版本完全一致，回滚只切换索引与证据关系版本，对客可见内容不变。";
  else impact = `回滚后对客可见内容将切换为目标包的 ${targetDocuments.length} 份资料：新增或改版 ${added.length + version_changed.length} 份，停用 ${removed.length} 份。`;

  return {
    has_current,
    same_package,
    current:packageSummary(current),
    target:packageSummary(target),
    current_documents:currentDocuments,
    target_documents:targetDocuments,
    added,
    removed,
    version_changed,
    unchanged,
    departments,
    impact
  };
};
