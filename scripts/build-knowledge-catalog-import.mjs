#!/usr/bin/env node
// Build-time importer for the approved internal Huamei v1 package.
// It emits a browser-safe management catalog.  It never marks source material
// as customer-facing and it deliberately carries provenance for every record.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultKnowledgeFile = resolve(scriptDir, "../../一期项目文件/华美智能体知识库_v1/rag/knowledge_units.jsonl");
const knowledgeFile = process.env.HUAMEI_KNOWLEDGE_CATALOG_SOURCE || defaultKnowledgeFile;
const rows = (await readFile(knowledgeFile, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const imageRecords = (prefix) => rows.filter((item) => item.record_type === "image_ocr" && item.source_relative_path?.startsWith(prefix));
const fileLike = (value = "") => /\.(?:jpe?g|png)$/i.test(value);
const cleanName = (value = "") => String(value).replace(/\s*(?:技术)?(?:院长|主任)$/u, "").trim();
const cleanText = (value = "", max = 360) => String(value)
  .replace(/^资料分类：[\s\S]*?原始素材：[^\n]*\n?/u, "")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, max);
const departmentMap = Object.freeze({
  "整形外科":"美容外科", "注射美容科":"微创美容科", "口腔美容":"口腔美容科",
  "毛发移植":"毛发移植科", "颜面轮廓":"美容外科", "微整形":"微创美容科"
});
const departmentFor = (value = "") => departmentMap[value] || value || "待科室核验";
const titleFor = (content = "") => (/副主任医师/u.test(content) ? "副主任医师"
  : /主任医师/u.test(content) ? "主任医师"
    : /主治医师/u.test(content) ? "主治医师" : "职称待资质核验");
const expertiseFor = (content = "", department = "") => {
  if (department === "口腔美容科") return ["口腔美容"];
  if (department === "毛发移植科") return ["毛发移植"];
  if (department === "皮肤美容科") return ["皮肤美容"];
  if (department === "微创美容科") return ["注射微整"];
  const candidate = [
    [/(?:眼部|重睑|双眼皮|眼袋)/u, "眼部整形"], [/(?:鼻部|隆鼻)/u, "鼻部整形"],
    [/(?:胸部|隆胸|丰胸)/u, "胸部整形"], [/(?:脂肪|吸脂|体雕)/u, "脂肪塑形"],
    [/(?:颧骨|下颌|面部轮廓)/u, "面部轮廓"], [/(?:唇部)/u, "唇部整形"]
  ];
  const values = candidate.filter(([pattern]) => pattern.test(content)).map(([, label]) => label).slice(0, 3);
  return values.length ? values : ["擅长领域待资质核验"];
};

const grouped = (records, keyFor) => {
  const map = new Map();
  for (const record of records) {
    const key = keyFor(record);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(record);
    map.set(key, list);
  }
  return map;
};

const doctorGroups = grouped(imageRecords("医生介绍/"), (record) => {
  const parts = record.source_relative_path.split("/");
  return parts.length >= 4 && fileLike(parts.at(-1)) && !/(?:中心|医生团|团队)$/u.test(parts[2]) ? `${parts[1]}\u0000${parts[2]}` : "";
});
const physicians = [...doctorGroups.entries()].map(([key, records], index) => {
  const [rawDepartment, rawName] = key.split("\u0000");
  const content = records.map((record) => record.content).join("\n");
  const department = departmentFor(rawDepartment);
  // Source filenames name the topic of a given doctor card much more reliably
  // than OCR body text, which often contains general anatomy terms unrelated
  // to that doctor's actual specialty.
  const profileText = records.map((record) => record.source_relative_path).join("\n");
  const name = cleanName(rawName);
  return {
    id:`KB-DR-${String(index + 1).padStart(3, "0")}`,
    name,
    title:titleFor(content),
    department,
    specialties:expertiseFor(profileText, department),
    bio:cleanText(content, 180),
    sourceRecordCount:records.length,
    sourceCollectionPath:`${records[0]?.source_relative_path.split("/").slice(0, -1).join("/") || "医生介绍"}/`
  };
}).sort((left, right) => left.department.localeCompare(right.department, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"));

const productRecords = [...imageRecords("项目介绍/"), ...imageRecords("明星产品/")
  .filter((record) => !record.source_relative_path.startsWith("明星产品/明星产品价格表/"))];
const priceRecords = [...imageRecords("项目价格/"), ...imageRecords("明星产品/")
  .filter((record) => record.source_relative_path.startsWith("明星产品/明星产品价格表/"))];
const priceDepartmentFor = (record) => {
  if (record.source_relative_path.startsWith("明星产品/")) return "产品中心";
  const directory = record.source_relative_path.split("/")[1] || "";
  return departmentFor(directory);
};
const productAliasOverrides = Object.freeze({
  "瑞可丽殊敏适":["舒敏适"]
});
const productAliases = (name = "") => [...new Set([
  name,
  String(name).replace(/^(?:瑞可丽|华美)/u, ""),
  String(name).replace(/(?:项目介绍|项目|系列|套餐|产品)$/u, ""),
  ...(productAliasOverrides[name] || [])
].map((item) => item.trim()).filter((item) => item.length >= 2))];
const formatCny = (value = "") => value.split(/([-~至—])/u).map((item) => /^[1-9]\d*$/u.test(item)
  ? Number(item).toLocaleString("zh-CN") : item).join("");
const priceTokensAfter = (content = "", index = 0) => {
  const scope = String(content).slice(index, index + 180).replace(/\n/gu, " ");
  const tokens = [];
  const matcher = /[1-9]\d{1,5}(?:\s*(?:-|~|至|—)\s*[1-9]\d{1,5})?/gu;
  for (const match of scope.matchAll(matcher)) {
    const value = match[0].replace(/\s+/gu, "");
    const rawNumber = Number(value.split(/[-~至—]/u)[0]);
    const suffix = scope.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 4);
    // Ignore OCR artefacts such as 5D, 20cm² and percentage labels. Retain
    // explicit ranges because price tables frequently use them.
    if (rawNumber < 50 || /^(?:%|cm|mm|D)/iu.test(suffix)) continue;
    tokens.push(value);
  }
  return tokens;
};
const priceReferenceFor = ({ name, department }) => {
  let best = null;
  for (const record of priceRecords) {
    const sameDepartment = priceDepartmentFor(record) === department;
    // Product-center goods may also appear verbatim in a skin-treatment price
    // list. Permit that only for the exact product name, never for a broad
    // alias such as “修复” or “美白”.
    const crossDepartmentExactMatch = department === "产品中心" && String(record.content || "").includes(name);
    if (!sameDepartment && !crossDepartmentExactMatch) continue;
    for (const alias of productAliases(name)) {
      if (!sameDepartment && alias !== name) continue;
      const index = String(record.content || "").indexOf(alias);
      if (index < 0) continue;
      const values = priceTokensAfter(record.content, index);
      if (!values.length) continue;
      const score = (record.source_relative_path.includes(alias) ? 10 : 0)
        + (department === "产品中心" && record.source_relative_path.startsWith("明星产品/") ? 20 : 0)
        + Math.max(0, 6 - Math.floor(index / 900));
      const candidate = {
        display:`¥${formatCny(values[0])}`,
        // OCR tables use inconsistent column orders (standard price, activity
        // price, package price, quantity, etc.). Do not infer an "original
        // price" from the next number; operators can maintain that field once
        // it is verified against the source table.
        original:"",
        sourcePath:record.source_relative_path,
        sourceExcerpt:cleanText(String(record.content).slice(index, index + 180), 180),
        score
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
};
const productKeyFor = (record) => {
  const parts = record.source_relative_path.split("/");
  const dirs = parts.slice(1, -1);
  if (!dirs.length) return "";
  const starProduct = record.source_relative_path.startsWith("明星产品/");
  const genericProjectDirectories = new Set(["口腔美容", "微整形", "整形外科", "毛发移植", "皮肤美容科", "颜面轮廓"]);
  if (!starProduct && dirs.length === 1 && genericProjectDirectories.has(dirs[0])) return "";
  // Source manuals (for example dental material manuals) are grouped under
  // their parent project rather than incorrectly becoming customer products.
  const technicalDirectory = /(?:Training|外科程序.*|Brochure|ASC|复合层.*|产品介绍)$/iu;
  const label = technicalDirectory.test(dirs.at(-1)) && dirs.length > 1 ? dirs.at(-2) : dirs.at(-1);
  const department = starProduct ? "产品中心" : departmentFor(parts[1]);
  return `${department}\u0000${label}`;
};
const productGroups = grouped(productRecords, productKeyFor);
const products = [...productGroups.entries()].map(([key, records], index) => {
  const [department, name] = key.split("\u0000");
  const firstParts = records[0]?.source_relative_path.split("/") || [];
  const firstDirs = firstParts.slice(1, -1);
  const starProduct = records[0]?.source_relative_path.startsWith("明星产品/");
  const category = starProduct
    ? `明星产品${firstDirs.length > 1 ? ` / ${firstDirs.slice(0, -1).join(" / ")}` : ""}`
    : firstDirs.slice(0, -1).join(" / ") || "项目资料";
  const reference = priceReferenceFor({ name, department });
  return {
    id:`KB-P-${String(index + 1).padStart(3, "0")}`,
    name,
    department,
    category,
    sourceRecordCount:records.length,
    sourceCollectionPath:`${records[0]?.source_relative_path.split("/").slice(0, -1).join("/") || "项目介绍"}/`,
    referencePrice:reference?.display || "",
    referenceOriginalPrice:reference?.original || "",
    referencePriceSourcePath:reference?.sourcePath || "",
    referencePriceExcerpt:reference?.sourceExcerpt || ""
  };
}).sort((left, right) => left.department.localeCompare(right.department, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"));

const priceGroups = grouped(priceRecords, (record) => {
  const parts = record.source_relative_path.split("/");
  const dirs = parts.slice(1, -1);
  if (record.source_relative_path.startsWith("明星产品/明星产品价格表/")) return "产品中心\u0000明星产品价格表";
  return dirs.length ? `${departmentFor(dirs[0])}\u0000${dirs.join(" / ")}` : "";
});
const prices = [...priceGroups.entries()].map(([key, records], index) => {
  const [department, product] = key.split("\u0000");
  return {
    id:`KB-PR-${String(index + 1).padStart(3, "0")}`,
    product,
    department,
    sourceRecordCount:records.length,
    sourceCollectionPath:`${records[0]?.source_relative_path.split("/").slice(0, -1).join("/") || "项目价格"}/`,
    sourcePreviews:records.slice(0, 3).map((record) => ({ path:record.source_relative_path, content:cleanText(record.content, 120) }))
  };
}).sort((left, right) => left.department.localeCompare(right.department, "zh-CN") || left.product.localeCompare(right.product, "zh-CN"));

const output = `// Generated by scripts/build-knowledge-catalog-import.mjs from 华美智能体知识库_v1.\n// Do not hand-edit: rebuild from the signed source package when the package changes.\nexport const KNOWLEDGE_CATALOG_IMPORT = Object.freeze(${JSON.stringify({
  // Bump whenever the matching policy changes, so a persisted browser catalog
  // refreshes only values that came from an earlier automatic import.
  schemaVersion:"huamei.knowledge-catalog-import.v9",
  sourcePackage:"华美智能体知识库_v1",
  sourcePackageVersion:"v1",
  importedAt:"2026-08-23T00:00:00.000Z",
  physicians,
  products,
  prices,
  summary:{ physicians:physicians.length, products:products.length, priceSources:prices.length, sourceKnowledgeUnits:7127, customerFacing:false }
})});\n`;
process.stdout.write(output);
