import Foundation

struct QuickInputService {
  let api: APIClient
  private let base = "/api/terminal/quick-inputs"

  func list(query: String = "", cursor: String? = nil) async throws -> BackendQuickInputPage {
    var components = URLComponents()
    components.queryItems = [
      URLQueryItem(name: "kind", value: "pinned"),
      URLQueryItem(name: "scope", value: "global"),
      URLQueryItem(name: "order", value: "manual"),
      URLQueryItem(name: "limit", value: "100"),
    ]
    if !query.isEmpty { components.queryItems?.append(URLQueryItem(name: "q", value: query)) }
    if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
    let page: BackendQuickInputPage = try await request("?" + (components.percentEncodedQuery ?? ""))
    guard page.orderVersion != nil else {
      throw BackendQuickInputFailure(code: "upgrade_required", message: "此电脑尚不支持全局快捷回复，请先更新电脑端。")
    }
    guard page.items.allSatisfy({ $0.projectId == nil && $0.pinned }) else {
      throw APIError.invalidResponse
    }
    return page
  }

  func create(title: String, data: String) async throws -> BackendQuickInput {
    let body: [String: Any] = [
      "title": title, "data": data, "mode": "line", "projectId": NSNull(), "source": "ios_quick_reply",
    ]
    return try await request("", method: "POST", body: body)
  }

  func update(_ item: BackendQuickInput, title: String, data: String) async throws -> BackendQuickInput {
    try await request("/\(APIClient.pathComponent(item.id))", method: "PATCH", body: [
      "title": title, "data": data, "expectedUpdatedAt": item.updatedAt,
    ])
  }

  func delete(_ id: String) async throws {
    let _: EmptyResponse = try await request("/\(APIClient.pathComponent(id))", method: "DELETE")
  }

  func move(_ id: String, beforeId: String?, orderVersion: String) async throws -> BackendQuickInputMove {
    try await request("/\(APIClient.pathComponent(id))/move", method: "POST", body: [
      "beforeId": beforeId.map { $0 as Any } ?? NSNull(), "expectedOrderVersion": orderVersion,
    ])
  }

  func markUsed(_ id: String) async throws -> BackendQuickInput {
    try await request("/\(APIClient.pathComponent(id))/used", method: "POST", body: [:])
  }

  func start(_ item: BackendQuickInput, projectId: String, key: String) async throws -> ScheduledRun {
    try await request("/\(APIClient.pathComponent(item.id))/run", method: "POST", body: [
      "projectId": projectId, "expectedInputUpdatedAt": item.updatedAt,
    ], key: key)
  }

  func runs(projectId: String, cursor: String? = nil) async throws -> ScheduledPage<ScheduledRun> {
    var components = URLComponents()
    components.queryItems = [
      URLQueryItem(name: "source", value: "quick-input"),
      URLQueryItem(name: "projectId", value: projectId),
      URLQueryItem(name: "limit", value: "100"),
    ]
    if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
    return try await api.authorized("/api/scheduled-tasks/runs?" + (components.percentEncodedQuery ?? ""))
  }

  private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil,
    key: String? = nil) async throws -> T {
    try await api.authorized(base + path, method: method, body: body,
      retryUnauthorized: method == "GET", idempotencyKey: key,
      decodeError: { _, data in try? JSONDecoder().decode(BackendQuickInputFailure.self, from: data) })
  }
}
