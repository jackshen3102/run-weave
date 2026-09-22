import Foundation

struct KnowledgeShareResult: Decodable {
  let reference: String
  let text: String
}

struct InboxRepository: Decodable, Identifiable {
  let repositoryId: String
  let displayName: String
  let projectAliases: [String]
  var id: String { repositoryId }
}
struct InboxItem: Decodable, Identifiable {
  let itemId: String
  let repositoryId: String
  let projectName: String
  let source: String
  let sourceId: String
  let sourceRevision: String
  let kind: String
  let title: String
  let statement: String
  let applicability: String
  let guidance: [String]?
  let actions: [String]?
  let avoid: [String]?
  let verification: [String]?
  let validationLabel: String
  let contentVersion: String
  let contentUpdatedAt: String
  let stateVersion: Int
  let processedAt: String?
  let hasUpdate: Bool
  let availability: String
  let currentContentVersion: String?
  var id: String { itemId }
  var excerpt: String { statement.isEmpty ? (actions?.first ?? applicability) : statement }
  var sourceLabel: String { source == "experience" ? "经验" : kind == "suggestion" ? "建议" : "洞察" }
  var updatedLabel: String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: contentUpdatedAt) else { return contentUpdatedAt }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
struct InboxPage: Decodable {
  let items: [InboxItem]
  let nextCursor: String?
  let sourceStatus: InboxSourceStatus
  let repositories: [InboxRepository]
}
struct InboxSourceStatus: Decodable {
  let status: String
  let evolution: String
  let experience: String
}
