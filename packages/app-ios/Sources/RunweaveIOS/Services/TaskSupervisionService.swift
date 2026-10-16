import Foundation

struct TaskSupervisionService {
  let api: APIClient

  func discover(terminalID: String) async throws -> SupervisionDiscovery {
    var query = URLComponents()
    query.queryItems = [URLQueryItem(name: "terminalSessionId", value: terminalID)]
    return try await api.authorized("/api/task-supervision?\(query.percentEncodedQuery ?? "")",
      decodeError: Self.failure)
  }

  func start(target: SupervisionTarget, requestID: String) async throws -> TaskWatch {
    try await api.authorized("/api/task-supervision", method: "POST",
      body: ["target": target.body, "taskStartMessageId": "", "goal": "",
        "planPaths": [String](), "requestId": requestID],
      retryUnauthorized: false, decodeError: Self.failure)
  }

  func change(watch: TaskWatch, enabled: Bool) async throws -> TaskWatch {
    try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watch.watchId))",
      method: "PATCH", body: ["action": enabled ? "resume" : "pause", "expectedRevision": watch.revision],
      retryUnauthorized: false, decodeError: Self.failure)
  }

  func retry(watch: TaskWatch, decisionID: String, inputVersion: String) async throws -> TaskWatch {
    try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watch.watchId))",
      method: "PATCH", body: ["action": "retry-continuation", "expectedRevision": watch.revision,
        "decisionId": decisionID, "expectedInputVersion": inputVersion],
      retryUnauthorized: false, decodeError: Self.failure)
  }

  func decisions(watchID: String, cursor: String?) async throws -> SupervisionDecisionPage {
    var query = URLComponents()
    if let cursor { query.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
    return try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watchID))/decisions?\(query.percentEncodedQuery ?? "")", decodeError: Self.failure)
  }

  func decision(watchID: String, decisionID: String) async throws -> SupervisionDecision {
    try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watchID))/decisions/\(APIClient.pathComponent(decisionID))", decodeError: Self.failure)
  }

  func previewGoal(watch: TaskWatch, content: SupervisionGoalContent?) async throws -> SupervisionGoalPreview {
    var body: [String: Any] = ["expectedRevision": watch.revision]
    if let content { body["content"] = content.body }
    return try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watch.watchId))/goal-preview",
      method: "POST", body: body, retryUnauthorized: false, requestTimeout: 120, decodeError: Self.failure)
  }

  func applyGoal(watchID: String, previewID: String) async throws -> TaskWatch {
    try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watchID))/goal-apply",
      method: "POST", body: ["previewId": previewID], retryUnauthorized: false, decodeError: Self.failure)
  }

  func goals(watchID: String, cursor: String?) async throws -> SupervisionGoalPage {
    var query = URLComponents()
    if let cursor { query.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
    return try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watchID))/goals?\(query.percentEncodedQuery ?? "")",
      decodeError: Self.failure)
  }

  func goal(watchID: String, revisionID: String) async throws -> SupervisionGoalDetail {
    try await api.authorized("/api/task-supervision/\(APIClient.pathComponent(watchID))/goals/\(APIClient.pathComponent(revisionID))",
      decodeError: Self.failure)
  }

  private static func failure(_ status: Int, _ data: Data) -> Error? {
    // Preserve HTTP identity for authentication and revision-conflict handling.
    guard status != 401, status != 409, status != 404 else { return nil }
    return try? JSONDecoder().decode(SupervisionFailure.self, from: data)
  }
}
