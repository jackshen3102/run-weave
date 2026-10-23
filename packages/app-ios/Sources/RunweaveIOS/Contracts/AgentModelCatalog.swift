import Foundation

struct AgentModelOption: Decodable, Identifiable, Equatable {
  let id: String
  let label: String
  let description: String
  let defaultReasoningEffort: String?
  let reasoningEfforts: [String]

  static func effortLabel(_ effort: String?) -> String {
    switch effort {
    case "minimal": "极低"
    case "low": "低"
    case "medium": "中"
    case "high": "高"
    case "xhigh": "很高"
    case "max": "最大"
    case "ultra": "极限"
    case nil: "未设置"
    default: effort ?? "未设置"
    }
  }
}

struct AgentModelCatalogs: Decodable {
  struct Catalog: Decodable {
    let availability: String
    let source: String
    let models: [AgentModelOption]
  }
  let catalogs: [String: Catalog]
}
