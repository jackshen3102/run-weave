import Foundation

struct BackendQuickInput: Decodable, Identifiable, Equatable {
  let id: String
  let title: String
  let data: String
  let mode: String
  let projectId: String?
  let pinned: Bool
  let updatedAt: String
}

struct BackendQuickInputPage: Decodable {
  let items: [BackendQuickInput]
  let nextCursor: String?
  let orderVersion: String?
}

struct BackendQuickInputMove: Decodable { let orderVersion: String }

struct BackendQuickInputFailure: Error, Decodable, LocalizedError {
  let code: String?
  let message: String
  var errorDescription: String? {
    switch code {
    case "input_changed": return "此快捷回复已在其他端修改，编辑内容已保留，请刷新后再保存。"
    case "list_changed": return "快捷回复顺序已变化，请刷新后重新排序。"
    case "config_required": return "请先在电脑端设置后台模型，再运行快捷指令。"
    default: return message
    }
  }
}
