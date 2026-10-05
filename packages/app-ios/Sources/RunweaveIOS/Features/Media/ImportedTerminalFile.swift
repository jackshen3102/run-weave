import Foundation

struct ImportedTerminalFile: Sendable {
  let data: Data
  let name: String

  static func read(_ url: URL) throws -> ImportedTerminalFile {
    let accessed = url.startAccessingSecurityScopedResource()
    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
    var result: Result<ImportedTerminalFile, Error>?
    var coordinationError: NSError?
    NSFileCoordinator().coordinate(readingItemAt: url, error: &coordinationError) { coordinatedURL in
      result = Result {
        let values = try coordinatedURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true else { throw AttachmentError("请选择文件") }
        guard (values.fileSize ?? 0) <= TerminalAttachmentLimits.maxBytes else {
          throw AttachmentError("文件不能超过 100 MB")
        }
        let data = try Data(contentsOf: coordinatedURL)
        guard data.count <= TerminalAttachmentLimits.maxBytes else {
          throw AttachmentError("文件不能超过 100 MB")
        }
        return ImportedTerminalFile(data: data, name: url.lastPathComponent)
      }
    }
    if let coordinationError { throw coordinationError }
    guard let result else { throw APIError.invalidResponse }
    return try result.get()
  }
}
