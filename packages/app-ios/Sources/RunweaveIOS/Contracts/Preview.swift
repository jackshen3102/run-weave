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
  let base: String?
  let mtimeMs: Double?
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
  var changeStatus: String?
  var readonly = false
  var id: String { (changeKind ?? "file") + ":" + path }
}

enum PreviewMutation {
  case delete(path: String, mtimeMs: Double? = nil)
  case reset(path: String, kind: String, status: String?)

  var path: String {
    switch self {
    case .delete(let path, _), .reset(let path, _, _): return path
    }
  }
  var title: String {
    switch self {
    case .delete: return "删除文件"
    case .reset(_, "staged", _): return "Reset · 取消暂存"
    case .reset: return "Reset · 丢弃修改"
    }
  }
  var message: String {
    let effect: String
    switch self {
    case .delete: effect = "将从电脑磁盘删除此文件，不会移入回收站。"
    case .reset(_, "staged", _): effect = "仅取消此文件的暂存，保留工作区文件内容。"
    case .reset(_, _, "untracked"): effect = "此文件尚未被 Git 跟踪，Reset 将直接删除文件，不会移入回收站。"
    case .reset: effect = "将此文件恢复到暂存区版本，丢弃未暂存的修改。"
    }
    return "\(path)\n\n\(effect)"
  }
}

func previewMutationError(_ error: Error) -> String {
  if case APIError.http(409) = error {
    return "操作未执行：文件或变更状态可能已变化，或项目路径不可用。请刷新后检查并重试。"
  }
  if case APIError.http(404) = error { return "文件已不存在，请刷新列表。" }
  if case APIError.http(403) = error { return "无法操作项目范围外的文件，或当前连接没有操作权限。" }
  if case APIError.http(400) = error { return "此操作只支持项目内的单个文件，不支持目录。" }
  return displayError(error)
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

// Mirrors shared/terminal/preview-core.ts isSupportedTerminalFileLinkPath.
// The Files browser still supports generic text; terminal detection is conservative.
private let terminalFileLinkExtensions: Set<String> = [
  "png", "jpg", "jpeg", "gif", "webp", "avif",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx",
  "css", "scss", "less", "html", "htm", "xml", "svg", "yaml", "yml",
  "py", "go", "rs", "rb", "java", "kt", "swift", "c", "cpp", "h", "hpp",
  "cs", "sh", "bash", "zsh", "sql", "graphql", "gql", "toml", "dockerfile",
  "lua", "php", "r", "vue", "txt", "log", "csv", "tsv", "ini", "conf",
]

func isSupportedTerminalFileLinkPath(_ path: String) -> Bool {
  guard !path.hasSuffix("/"), !path.hasSuffix("\\") else { return false }
  let basename = path.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
  guard let dot = basename.lastIndex(of: "."), dot != basename.startIndex else { return false }
  return terminalFileLinkExtensions.contains(String(basename[basename.index(after: dot)...]).lowercased())
}

struct TerminalFilePanel: Decodable {
  struct Geometry: Decodable {
    let paneLeft: Int
    let paneTop: Int
    let paneWidth: Int
    let paneHeight: Int
    let windowWidth: Int
    let windowHeight: Int
  }
  let panelId: String
  let geometry: Geometry?
}
struct TerminalFileWorkspace: Decodable { let panels: [TerminalFilePanel] }
struct TerminalFileCandidate: Decodable, Identifiable {
  let path: String
  let absolutePath: String
  let base: String
  var id: String { absolutePath }
}
struct TerminalFileResolution: Decodable { let candidates: [TerminalFileCandidate] }

struct TerminalFileLinkContext {
  let linePrefix: String
  let precedingLines: [String]
}
