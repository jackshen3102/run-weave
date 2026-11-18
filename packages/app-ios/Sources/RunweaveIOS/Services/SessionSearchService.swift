import Foundation

struct SessionSearchService {
  let api: APIClient
  func status() async throws -> SessionSearchStatus { try await api.authorized("/api/session-search/status") }
  func refresh() async throws {
    let _: SessionSearchStatus = try await api.authorized("/api/session-search/refresh", method: "POST", body: [:], retryUnauthorized: false, requestTimeout: 30 * 60)
  }
  func search(query: String, projectID: String, provider: String, level: String, others: Bool, cursor: String?) async throws -> SessionSearchPage {
    var parts = URLComponents()
    parts.queryItems = [URLQueryItem(name: "query", value: query), URLQueryItem(name: "level", value: level),
      URLQueryItem(name: "includeOtherOrigins", value: String(others)),
      URLQueryItem(name: projectID == "all" ? "allProjects" : "projectId", value: projectID == "all" ? "true" : projectID)]
    if !provider.isEmpty { parts.queryItems?.append(URLQueryItem(name: "provider", value: provider)) }
    if let cursor { parts.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
    return try await api.authorized("/api/session-search/search?\(parts.percentEncodedQuery ?? "")", requestTimeout: 30 * 60)
  }
  func context(_ id: String) async throws -> SessionSearchContext {
    try await api.authorized("/api/session-search/records/\(APIClient.pathComponent(id))", requestTimeout: 30 * 60)
  }
}
