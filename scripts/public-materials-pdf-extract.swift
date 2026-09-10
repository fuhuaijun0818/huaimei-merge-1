import Foundation
import PDFKit

struct PDFResult: Encodable {
    let source_path: String
    let status: String
    let text: String
    let page_count: Int
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1 else {
    FileHandle.standardError.write(Data("Usage: public-materials-pdf-extract pdf-path\n".utf8))
    exit(2)
}

let sourcePath = arguments[0]
let url = URL(fileURLWithPath: sourcePath)
let result: PDFResult
if let document = PDFDocument(url: url) {
    let pages = (0..<document.pageCount).compactMap { index -> String? in
        guard let text = document.page(at: index)?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
    result = PDFResult(source_path: sourcePath, status: "ok", text: pages.joined(separator: "\n\n"), page_count: document.pageCount)
} else {
    result = PDFResult(source_path: sourcePath, status: "error", text: "", page_count: 0)
}

let encoder = JSONEncoder()
if let data = try? encoder.encode(result) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
