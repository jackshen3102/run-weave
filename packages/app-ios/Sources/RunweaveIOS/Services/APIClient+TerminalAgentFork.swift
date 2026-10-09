import Foundation

extension APIClient {
  func terminalAgentForkTarget(id: String) async throws -> TerminalAgentForkTarget {
    try await authorized("/api/terminal/session/\(Self.pathComponent(id))/agent/fork-target",
      decodeError: { _, data in try? JSONDecoder().decode(TerminalAgentForkFailure.self, from: data) })
  }

  func forkTerminalAgent(id: String, target: TerminalAgentForkTarget,
    operationID: String) async throws -> ForkTerminalAgentResponse {
    try await authorized("/api/terminal/session/\(Self.pathComponent(id))/agent/fork", method: "POST",
      body: ["operationId": operationID, "panelId": target.panelId,
        "expectedThreadId": target.threadId, "expectedRevision": target.revision],
      retryUnauthorized: false, requestTimeout: 75,
      decodeError: { _, data in try? JSONDecoder().decode(TerminalAgentForkFailure.self, from: data) })
  }
}
