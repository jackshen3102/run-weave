import Foundation

struct PreviewEntry: Decodable, Identifiable {
  let kind: String
  let path: String
  let basename: String
  let dirname: String
  let sizeBytes: Int?
  var id: String { path }
}
struct PreviewDirectory: Decodable {
  let path: String
  let entries: [PreviewEntry]
  let truncated: Bool
}
struct PreviewSearch: Decodable {
  let items: [PreviewSearchItem]
  let truncated: Bool
}
struct PreviewSearchItem: Decodable, Identifiable {
  let path: String
  let basename: String
  let dirname: String
  let gitStatus: String?
  var id: String { path }
}
struct PreviewFile: Decodable {
  let path: String
  let absolutePath: String
  let language: String
  let content: String
  let sizeBytes: Int
  let readonly: Bool
}
struct PreviewChange: Decodable, Identifiable {
  let path: String
  let status: String
  var id: String { path }
}
struct PreviewChanges: Decodable {
  let staged: [PreviewChange]
  let working: [PreviewChange]
}
struct PreviewDiff: Decodable {
  let path: String
  let oldContent: String
  let newContent: String
}
struct SelectedFile: Identifiable, Equatable {
  let path: String
  var changeKind: String?
  var id: String { (changeKind ?? "file") + ":" + path }
}

func previewError(_ error: Error) -> String {
  if case APIError.http(409) = error { return "请先设置项目路径，再使用 Files 和 Changes" }
  if case APIError.http(413) = error { return "文件太大，无法预览" }
  if case APIError.http(415) = error { return "此二进制文件不支持预览" }
  return displayError(error)
}
func isPreviewImage(_ path: String) -> Bool {
  ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].contains(
    (path as NSString).pathExtension.lowercased())
}
