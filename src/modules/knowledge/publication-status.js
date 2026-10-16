// 资料列表要同时回答三个不同维度的问题，这里把“索引状态”和“发布状态”各自算清楚：
//   资料状态：资料自身处在待解析 / 草稿 / 候选阶段（来自 status 字段）
//   索引状态：内部检索块是否可用（来自 retrieval_index_status + indexed_chunk_count）
//   发布状态：是否已进入发布包并对客启用（必须结合发布包，不能只看资料自身字段）

const INDEX_STATUS = {
  indexed:{ label:"已索引", tone:"success" },
  indexing:{ label:"索引中", tone:"warning" },
  awaiting_parse:{ label:"待解析", tone:"warning" },
  awaiting_correction:{ label:"待修正", tone:"warning" }
};

export const indexStatusLabel = (status) => INDEX_STATUS[String(status || "").trim()] || { label:"未建立索引", tone:"outline" };

export const PUBLICATION_STATUS_LEGEND = "说明：资料状态＝资料自身处在草稿/候选阶段；索引状态＝内部检索块是否可用；发布状态＝是否已进入发布包并对客启用。三者互相独立，候选待评测不等于已对客发布。";

const PACKAGE_RULES = [
  { key:"active", label:"对客启用", tone:"success", match:(pkg) => pkg?.active === true },
  { key:"evaluated", label:"已评测，未启用", tone:"success", match:(pkg) => pkg?.status === "evaluated" },
  { key:"awaiting_evaluation", label:"候选包待评测", tone:"warning", match:(pkg) => pkg?.status === "awaiting_evaluation" }
];

export const summarizeDocumentPublicationStatus = ({ document = {}, publications = [] } = {}) => {
  const documentId = String(document?.id || "");
  const packages = (Array.isArray(publications) ? publications : [])
    .filter((pkg) => Array.isArray(pkg?.documents) && pkg.documents.some((item) => String(item?.id || "") === documentId));

  for (const rule of PACKAGE_RULES) {
    const hit = packages.find(rule.match);
    if (hit) {
      return {
        key:rule.key,
        label:rule.label,
        tone:rule.tone,
        package_id:String(hit.id || ""),
        in_package:true
      };
    }
  }

  const ready = document?.publication_readiness?.ready === true;
  return {
    key:ready ? "ready" : "unpublished",
    label:ready ? "可准备候选" : "未进入发布包",
    tone:ready ? "warning" : "outline",
    package_id:"",
    in_package:false
  };
};
