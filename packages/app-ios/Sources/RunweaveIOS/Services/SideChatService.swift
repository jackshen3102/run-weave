import Foundation

struct SideChatService {
  let api: APIClient
  func capabilities(terminalID: String) async throws -> SideChatCapabilities {
    var query = URLComponents()
    query.queryItems = [URLQueryItem(name: "terminalSessionId", value: terminalID)]
    return try await api.authorized("/api/side-chats/capabilities?\(query.percentEncodedQuery ?? "")", decodeError: Self.failure)
  }
  func create(operationID: String, source: SideChatSourceRef) async throws -> SideChatWriteResponse {
    try await api.authorized("/api/side-chats", method: "POST",
      body: ["operationId": operationID, "source": source.body], retryUnauthorized: false, decodeError: Self.failure)
  }
  func snapshot(_ id: String) async throws -> SideChatSnapshot {
    try await api.authorized(path(id), decodeError: Self.failure)
  }
  func messages(_ id: String, before: Int) async throws -> SideChatMessagePage {
    try await api.authorized(path(id) + "/messages?beforeSequence=\(before)&limit=50", decodeError: Self.failure)
  }
  func operation(_ id: String, operationID: String) async throws -> SideChatOperation {
    try await api.authorized(path(id) + "/operations/" + APIClient.pathComponent(operationID), decodeError: Self.failure)
  }
  func send(_ id: String, operationID: String, version: Int, text: String) async throws -> SideChatWriteResponse {
    try await api.authorized(path(id) + "/turns", method: "POST",
      body: ["operationId": operationID, "expectedVersion": version, "text": text],
      retryUnauthorized: false, decodeError: Self.failure)
  }
  func stop(_ id: String, turnID: String, operationID: String, version: Int) async throws -> SideChatWriteResponse {
    let target = path(id) + "/turns/" + APIClient.pathComponent(turnID) + "/stop"
    do {
      return try await api.authorized(target, method: "POST",
        body: ["operationId": operationID, "expectedVersion": version], retryUnauthorized: false, decodeError: Self.failure)
    } catch let error as SideChatFailure where error.status == 409 && error.code == "VERSION_CONFLICT" {
      let latest = try await snapshot(id)
      // Retry only this still-running turn after a definite version rejection.
      guard latest.sideChat.status == "active", let turn = latest.currentTurn, turn.id == turnID,
            ["accepted", "running"].contains(turn.state) else { throw error }
      return try await api.authorized(target, method: "POST",
        body: ["operationId": operationID, "expectedVersion": latest.sideChat.version], retryUnauthorized: false, decodeError: Self.failure)
    }
  }
  func end(_ id: String, operationID: String, version: Int) async throws -> SideChatWriteResponse {
    try await api.authorized(path(id) + "/end", method: "POST",
      body: ["operationId": operationID, "expectedVersion": version], retryUnauthorized: false, decodeError: Self.failure)
  }
  private func path(_ id: String) -> String { "/api/side-chats/" + APIClient.pathComponent(id) }
  private static func failure(_ status: Int, _ data: Data) -> Error? {
    guard ![401, 404].contains(status) else { return nil }
    struct Payload: Decodable { let code: String; let message: String }
    guard let value = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
    return SideChatFailure(status: status, code: value.code, message: value.message)
  }
}
