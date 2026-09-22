import Foundation

struct KnowledgeInboxService {
  let api: APIClient
  func share(_ item: InboxItem) async throws -> KnowledgeShareResult {
    try await api.authorized("/api/knowledge-inbox/items/\(APIClient.pathComponent(item.id))/share", method: "POST", body: [
      "contentVersion": item.contentVersion, "sourceRevision": item.sourceRevision,
    ], retryUnauthorized: false)
  }
  func list(state: String = "pending", source: String = "", repositoryID: String = "", limit: Int = 20, cursor: String? = nil) async throws -> InboxPage {
    var query = URLComponents()
    query.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "limit", value: String(limit))]
    if !source.isEmpty { query.queryItems?.append(URLQueryItem(name: "source", value: source)) }
    if !repositoryID.isEmpty { query.queryItems?.append(URLQueryItem(name: "repositoryId", value: repositoryID)) }
    if let cursor { query.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
    return try await api.authorized("/api/knowledge-inbox/items?\(query.percentEncodedQuery ?? "")")
  }
  func detail(_ id: String, version: String? = nil) async throws -> InboxItem {
    let suffix = version.map { "?contentVersion=\(APIClient.pathComponent($0))" } ?? ""
    return try await api.authorized("/api/knowledge-inbox/items/\(APIClient.pathComponent(id))\(suffix)")
  }
  func change(_ item: InboxItem) async throws -> InboxItem {
    return try await api.authorized("/api/knowledge-inbox/items/\(APIClient.pathComponent(item.id))/state", method: "PATCH", body: [
      "state": item.processedAt == nil ? "processed" : "pending",
      "expectedContentVersion": item.contentVersion, "expectedStateVersion": item.stateVersion,
    ], retryUnauthorized: false)
  }
}
