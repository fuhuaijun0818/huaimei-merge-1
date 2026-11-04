import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";

export const HR_RESUME_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const HR_RESUME_FILE_MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 50_000;

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const safeFileName = (value) => {
  const name = basename(String(value || "")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 160) throw fail("HR_RESUME_FILE_NAME_INVALID", "简历文件名无效或超过160个字符");
  return name;
};
const safeMime = (value) => String(value || "").split(";")[0].trim().toLowerCase().slice(0, 120);
const decodeBase64 = (value) => {
  const encoded = String(value || "").trim();
  if (!encoded || encoded.length > Math.ceil(HR_RESUME_FILE_MAX_BYTES * 4 / 3) + 4
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw fail("HR_RESUME_FILE_INVALID", "简历附件内容无效");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > HR_RESUME_FILE_MAX_BYTES) {
    throw fail("HR_RESUME_FILE_SIZE_INVALID", "简历附件不能超过5MB");
  }
  return buffer;
};
const decodeXmlEntities = (value) => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
  const named = { "&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&apos;":"'" };
  const lower = entity.toLowerCase();
  if (named[lower]) return named[lower];
  const numeric = lower.startsWith("&#x")
    ? Number.parseInt(entity.slice(3, -1), 16)
    : Number.parseInt(entity.slice(2, -1), 10);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
});
const normalizeExtractedText = (value) => String(value || "")
  .replace(/\u0000/g, "")
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{4,}/g, "\n\n\n")
  .trim()
  .slice(0, MAX_EXTRACTED_TEXT);
const textFromBuffer = (buffer) => {
  if (buffer.includes(0)) throw fail("HR_RESUME_FILE_SIGNATURE_INVALID", "文本简历包含无效二进制内容");
  try {
    return new TextDecoder("utf-8", { fatal:true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw fail("HR_RESUME_TEXT_ENCODING_INVALID", "文本简历必须使用UTF-8编码，请另存为UTF-8后重试");
  }
};
const textFromPdf = async (buffer) => {
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw fail("HR_RESUME_FILE_SIGNATURE_INVALID", "PDF文件签名与扩展名不一致");
  }
  let parser;
  try {
    parser = new PDFParse({ data:buffer });
    const result = await parser.getText({ first:20 });
    return {
      text:normalizeExtractedText(result.text),
      parser:"pdf-parse",
      pages:Array.isArray(result.pages) ? result.pages.length : null
    };
  } catch (error) {
    if (String(error?.code || "").startsWith("HR_RESUME_")) throw error;
    throw fail("HR_RESUME_PDF_PARSE_FAILED", "PDF简历解析失败；加密或损坏文件请另存后再上传", 422);
  } finally {
    try { await parser?.destroy?.(); } catch {}
  }
};
const textFromDocx = async (buffer) => {
  if (buffer.subarray(0, 4).toString("ascii") !== "PK\u0003\u0004") {
    throw fail("HR_RESUME_FILE_SIGNATURE_INVALID", "DOCX文件签名与扩展名不一致");
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32:false });
  } catch {
    throw fail("HR_RESUME_DOCX_PARSE_FAILED", "DOCX简历文件损坏，无法解析", 422);
  }
  const entries = Object.values(zip.files || {});
  const uncompressedBytes = entries.reduce((total, entry) => total + Number(entry?._data?.uncompressedSize || 0), 0);
  if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw fail("HR_RESUME_DOCX_TOO_LARGE", "DOCX解压后体积过大，无法安全解析", 422);
  }
  const documentXmlEntry = zip.file("word/document.xml");
  if (!documentXmlEntry) throw fail("HR_RESUME_DOCX_PARSE_FAILED", "DOCX中未找到正文内容", 422);
  const xml = await documentXmlEntry.async("string");
  if (Buffer.byteLength(xml, "utf8") > MAX_DOCUMENT_XML_BYTES) {
    throw fail("HR_RESUME_DOCX_TOO_LARGE", "DOCX正文体积过大，无法安全解析", 422);
  }
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return {
    text:normalizeExtractedText(decodeXmlEntities(text)),
    parser:"docx-xml",
    pages:null
  };
};

export async function extractResumeAttachment(payload = {}) {
  const fileName = safeFileName(payload.file_name);
  const extension = extname(fileName).toLowerCase();
  const suppliedMime = safeMime(payload.mime_type);
  const expectedMime = {
    ".pdf":"application/pdf",
    ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt":"text/plain",
    ".md":"text/markdown",
    ".markdown":"text/markdown"
  }[extension];
  if (!expectedMime) throw fail("HR_RESUME_FILE_TYPE_UNSUPPORTED", "仅支持PDF、DOCX、TXT和Markdown简历");
  if (suppliedMime && !["application/octet-stream", expectedMime].includes(suppliedMime)) {
    throw fail("HR_RESUME_FILE_MIME_UNSUPPORTED", "简历附件MIME类型与扩展名不一致");
  }
  const buffer = decodeBase64(payload.data_base64);
  let parsed;
  if (extension === ".pdf") parsed = await textFromPdf(buffer);
  else if (extension === ".docx") parsed = await textFromDocx(buffer);
  else if ([".txt", ".md", ".markdown"].includes(extension)) {
    parsed = { text:normalizeExtractedText(textFromBuffer(buffer)), parser:"utf8-text", pages:null };
  }
  if (parsed.text.length < 20) {
    throw fail("HR_RESUME_FILE_TEXT_REQUIRED", "未能从附件提取有效简历文本；扫描版PDF暂不支持OCR", 422);
  }
  return {
    ...parsed,
    file_name:fileName,
    mime_type:expectedMime,
    file_size:buffer.length,
    file_sha256:createHash("sha256").update(buffer).digest("hex"),
    extracted_chars:parsed.text.length
  };
}
