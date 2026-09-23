import Foundation

struct ScheduledTasksService {
  let api: APIClient
  private let base = "/api/scheduled-tasks"
  func request<T: Decodable>(_ path: String = "", method: String = "GET", body: [String: Any]? = nil, key: String? = nil) async throws -> T {
    try await api.authorized(base + path, method: method, body: body, retryUnauthorized: method == "GET",
      idempotencyKey: key, decodeError: { _, data in try? JSONDecoder().decode(ScheduledFailure.self, from: data) })
  }
  func capabilities() async throws -> ScheduledCapabilities { try await request("/capabilities") }
  func list(q: String, project: String, archived: Bool, cursor: String? = nil) async throws -> ScheduledPage<ScheduledTaskRecord> {
    try await request(query(["q": q, "parentProjectId": project, "archived": String(archived), "cursor": cursor, "limit": "20"]))
  }
  func task(_ id: String) async throws -> ScheduledTaskRecord { try await request("/\(APIClient.pathComponent(id))") }
  func runs(_ id: String, cursor: String? = nil) async throws -> ScheduledPage<ScheduledRun> {
    try await request("/\(APIClient.pathComponent(id))/runs" + query(["cursor": cursor, "limit": "20"]))
  }
  func run(_ id: String) async throws -> ScheduledRun { try await request("/runs/\(APIClient.pathComponent(id))") }
  func save(_ body: [String: Any], id: String?, key: String) async throws -> ScheduledTaskRecord {
    try await request(id.map { "/\(APIClient.pathComponent($0))" } ?? "", method: id == nil ? "POST" : "PATCH", body: body, key: id == nil ? key : nil)
  }
  func remove(_ task: ScheduledTaskRecord) async throws -> ScheduledTaskRecord {
    try await request("/\(APIClient.pathComponent(task.id))", method: "DELETE", body: ["expectedRevision": task.revision])
  }
  func start(_ id: String, key: String) async throws -> ScheduledRun {
    try await request("/\(APIClient.pathComponent(id))/runs", method: "POST", body: [:], key: key)
  }
  func stop(_ id: String) async throws -> ScheduledRun { try await request("/runs/\(APIClient.pathComponent(id))/stop", method: "POST", body: [:]) }
  func output(_ id: String, cursor: String?) async throws -> ScheduledOutput {
    try await request("/runs/\(APIClient.pathComponent(id))/output" + query(["cursor": cursor]))
  }
  func open(_ id: String, replace: Bool = false) async throws -> ScheduledOpenResponse {
    try await request("/runs/\(APIClient.pathComponent(id))/open-terminal", method: "POST", body: ["replaceRepurposedBinding": replace])
  }
  func preview(_ schedule: ScheduledTaskSchedule) async throws -> ScheduledPreview {
    try await request("/preview", method: "POST", body: ["schedule": schedule.body])
  }
  func contexts(_ id: String) async throws -> [ScheduledProjectContext] {
    try await api.authorized("/api/terminal/project/\(APIClient.pathComponent(id))/contexts")
  }
  func models() async throws -> ScheduledModelSettings { try await api.authorized("/api/agent-team/model-settings") }
  private func query(_ values: [String: String?]) -> String {
    var parts = URLComponents()
    parts.queryItems = values.sorted { $0.key < $1.key }.compactMap { key, value in
      guard let value, !value.isEmpty else { return nil }
      return URLQueryItem(name: key, value: value)
    }
    return parts.percentEncodedQuery.map { "?" + $0 } ?? ""
  }
}
