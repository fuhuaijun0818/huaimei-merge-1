from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any


_DIRECT_IDENTIFIER_PATTERNS = (
    re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE),
    re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    re.compile(r"(?<!\d)\d{17}[0-9Xx](?!\d)"),
    re.compile(r"(?:微信|微\s*信号?|wechat|手机号|手机号码|联系电话|电话号码|邮箱|身份证号?)[：:\s]*[A-Z0-9._@+-]{3,}", re.IGNORECASE),
)

_PRIVATE_FREE_TEXT = re.compile(
    r"(?:我叫|我的|本人|患者|客户|姓名|称呼|住在|家庭住址|收货地址|地址是|"
    r"病史|既往史|过敏史|用药史|正在服用|怀孕|孕周|哺乳|身份证|手机号|"
    r"手机号码|联系电话|电话号码|微信|邮箱)",
    re.IGNORECASE,
)

_SENTENCE_PUNCTUATION = re.compile(r"[，。！？!?；;：:\"'“”‘’@#]")

# This is an outbound data-classification boundary, not a natural-language
# classifier.  The acquisition service may send only controlled business
# taxonomy tokens.  New free-form phrases therefore fail closed until they are
# either present in an approved catalog path or added to this reviewed list.
_REVIEWED_TAXONOMY_TERMS = frozenset({
    # Canonical projects used by the deterministic Node intent engine.
    "线雕提升", "热玛吉", "提眉", "拉皮/微拉美面部提升", "自体脂肪隆胸",
    "注射瘦脸", "面部轮廓整形", "自体脂肪填充", "玻尿酸填充", "双眼皮",
    "吸脂塑形", "泪沟填充", "祛眼袋", "抗初老/紧致除皱", "隆胸/胸部整形",
    "下巴整形", "光子嫩肤", "鼻部整形", "假体隆鼻", "皮秒激光祛斑",
    # Canonical business aliases and body-part taxonomy.
    "胸部整形", "鼻部整形", "眼部整形", "面部年轻化", "自体脂肪",
    "皮肤美容", "形体塑形", "面部轮廓", "口腔美容", "毛发移植",
    "面部", "眼部", "鼻部", "胸部", "身体",
    # Controlled concern entities.
    "松弛", "下垂", "皱纹", "法令纹", "暗沉", "发黄", "色斑", "斑点", "痘印", "痘坑",
    "毛孔", "缺水", "干燥", "胎记", "太田痣", "鲜红斑痣", "雀斑样痣", "咖啡斑",
    "色素痣", "黑痣", "血管瘤", "眼袋", "泪沟", "内双", "鼻梁", "鼻尖", "鼻翼", "咬肌",
    "下颌线", "双下巴", "胸部不对称", "腰腹", "大腿", "手臂",
    # Fixed retrieval facets. These contain no customer-supplied values.
    "恢复", "恢复期", "术后", "拆线", "住院", "消肿", "价格", "报价", "费用", "收费",
    "预算", "活动", "优惠", "套餐", "权益", "水滴", "水滴形", "水滴型", "解剖型",
    "圆形", "光面", "微绒面", "绒面", "型号", "材料", "材质", "品牌", "假体形状",
    "风险", "副作用", "并发症", "禁忌", "安全", "流程", "步骤", "手术方式", "麻醉", "全麻", "局麻",
    "自然", "垂感", "垂坠", "柔软", "挺拔", "明显", "保守", "不夸张", "擅长", "专业方向",
    "资质", "职称", "排班", "出诊", "坐诊", "在院", "点痣", "CO2激光点痣",
    # Non-sensitive navigation words used only in synthetic/service probes.
    "医生", "院长", "专家", "项目介绍", "项目方向", "核验", "服务", "医院地址", "停车",
    "拉皮", "微拉美", "隆胸", "丰胸", "黑痣", "痣",
})

_SAFE_CATALOG_SEGMENT = re.compile(r"^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9_.+··®™()-]{1,39}$")


def _catalog_records(engine: Any) -> Iterable[dict]:
    documents = getattr(engine, "documents", None)
    if isinstance(documents, list):
        return (item for item in documents if isinstance(item, dict))
    catalog = getattr(engine, "record_catalog", None)
    if isinstance(catalog, dict):
        return (item for item in catalog.values() if isinstance(item, dict))
    return ()


def approved_retrieval_terms(engine: Any) -> frozenset[str]:
    """Build safe nouns from immutable, privacy-reviewed catalog paths."""

    terms = set(_REVIEWED_TAXONOMY_TERMS)
    for record in _catalog_records(engine):
        path = unicodedata.normalize("NFKC", str(record.get("source_relative_path") or "")).strip()
        segments = path.split("/")
        # Directory overview records use their most-specific directory as the
        # final segment; source-file records exclude the filename. This makes a
        # configured immutable readiness record addressable without accepting
        # arbitrary user prose.
        if str(record.get("record_type") or "") != "directory_overview":
            segments = segments[:-1]
        for raw_segment in segments:
            segment = raw_segment.strip()
            if _SAFE_CATALOG_SEGMENT.fullmatch(segment):
                terms.add(segment)
    return frozenset(terms)


def validate_retrieval_query_privacy(value: str, approved_terms: frozenset[str] | None = None) -> str:
    """Accept taxonomy search phrases, never raw customer conversation text.

    The acquisition service is the only component allowed to transform a
    customer utterance into controlled project/doctor/facet terms. This second
    boundary prevents a future or misconfigured caller from forwarding contact
    data or medical history to the GraphRAG query model.
    """

    query = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not query:
        raise ValueError("QUERY_PRIVACY_REJECTED")
    if _SENTENCE_PUNCTUATION.search(query) or _PRIVATE_FREE_TEXT.search(query):
        raise ValueError("QUERY_PRIVACY_REJECTED")
    if any(pattern.search(query) for pattern in _DIRECT_IDENTIFIER_PATTERNS):
        raise ValueError("QUERY_PRIVACY_REJECTED")
    if re.search(r"(?<!\d)\d{6,}(?!\d)", query):
        raise ValueError("QUERY_PRIVACY_REJECTED")
    terms = query.split()
    allowlist = approved_terms or _REVIEWED_TAXONOMY_TERMS
    if not terms or len(terms) > 16:
        raise ValueError("QUERY_PRIVACY_REJECTED")
    if any(term not in allowlist for term in terms):
        raise ValueError("QUERY_PRIVACY_REJECTED")
    return " ".join(terms)
