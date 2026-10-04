import Foundation

extension APIClient {
  func terminalQuestions(id: String, panelID: String?) async throws -> TerminalQuestionsResponse {
    let query = panelID.map { "?panelId=\(Self.pathComponent($0))" } ?? ""
    return try await authorized("/api/terminal/session/\(Self.pathComponent(id))/questions\(query)")
  }

  func answerTerminalQuestion(id: String, panelID: String, request: TerminalQuestionRequest,
    operationID: String, answers: [String: String]) async throws -> TerminalQuestionsResponse {
    try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))/questions/\(Self.pathComponent(request.requestId))/answer",
      method: "POST", body: [
        "panelId": panelID, "generation": request.generation, "threadId": request.threadId,
        "turnId": request.turnId, "itemId": request.itemId, "operationId": operationID,
        "answers": answers.mapValues { ["answers": [$0]] }
      ], retryUnauthorized: false)
  }
}
