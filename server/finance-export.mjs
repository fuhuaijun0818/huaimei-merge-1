import JSZip from "jszip";

const HEADERS = Object.freeze([
  ["单据编号", 22],
  ["审批流程", 16],
  ["所属公司", 20],
  ["费用类型", 16],
  ["项目名称", 20],
  ["申请人", 14],
  ["工号/账号", 20],
  ["费用金额（元）", 16],
  ["成本中心", 18],
  ["发票/凭据号", 20],
  ["报销说明", 32],
  ["审批状态", 12],
  ["审批完成时间", 22],
  ["审批人", 18]
]);
const REQUEST_TYPE_LABELS = Object.freeze({
  expense:"费用报销",
  payment:"付款申请",
  procurement:"采购申请"
});

const xmlEscape = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");
const excelText = (value) => {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, 32_000);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};
const cellReference = (row, column) => {
  let value = column;
  let letters = "";
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + value % 26) + letters;
    value = Math.floor(value / 26);
  }
  return `${letters}${row}`;
};
const cellXml = (value, row, column, style = 0) => {
  const ref = cellReference(row, column);
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(excelText(value))}</t></is></c>`;
};
const worksheetXml = (rows) => {
  const allRows = [HEADERS.map(([header]) => header), ...rows];
  const maxColumns = HEADERS.length;
  const rowXml = allRows.map((row, index) => `<row r="${index + 1}">${Array.from({ length:maxColumns }, (_, column) => cellXml(row[column] ?? "", index + 1, column + 1, index === 0 ? 1 : 0)).join("")}</row>`).join("");
  const columns = HEADERS.map(([, width], index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${cellReference(allRows.length, maxColumns).replace(/\d+$/, "")}${allRows.length}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columns}</cols>
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A1:${cellReference(1, maxColumns)}"/>
</worksheet>`;
};
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7A3544"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export async function buildApprovedFinanceWorkbook(requests) {
  const rows = requests.map((request) => [
    request.id,
    REQUEST_TYPE_LABELS[request.type] || request.type,
    request.company,
    request.expense_type,
    request.project_name,
    request.applicant,
    request.employee_account,
    Number(request.amount),
    request.cost_center,
    request.invoice_reference,
    request.description,
    request.approval_status === "approved" ? "审批完成" : request.approval_status,
    request.approved_at,
    request.approved_by
  ]);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder("xl").file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="财务审批已完成" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.folder("xl").folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.folder("xl").file("styles.xml", stylesXml);
  zip.folder("xl").folder("worksheets").file("sheet1.xml", worksheetXml(rows));
  return zip.generateAsync({ type:"nodebuffer", compression:"DEFLATE", compressionOptions:{ level:6 } });
}
