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

  private static func failure(_ status: Int, _ data: Data) -> Error? {
    // Preserve HTTP identity for authentication and revision-conflict handling.
    guard status != 401, status != 409, status != 404 else { return nil }
    return try? JSONDecoder().decode(SupervisionFailure.self, from: data)
  }
}
