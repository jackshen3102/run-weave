import Foundation
struct TerminalCodeReviewService {
  let api: APIClient
  func list(terminalID: String, before: String? = nil) async throws -> TerminalCodeReviewPage {
    var query = URLComponents()
    if let before { query.queryItems = [URLQueryItem(name: "before", value: before)] }
    return try await api.authorized("/api/terminal/session/\(APIClient.pathComponent(terminalID))/code-reviews?\(query.percentEncodedQuery ?? "")")
  }
  func start(terminalID: String, requestID: String) async throws -> TerminalCodeReviewRun {
    try await api.authorized("/api/terminal/session/\(APIClient.pathComponent(terminalID))/code-reviews", method: "POST",
      body: ["requestId": requestID], retryUnauthorized: false)
  }
  func detail(_ reviewID: String) async throws -> TerminalCodeReviewDetail {
    try await api.authorized("/api/terminal/code-reviews/\(APIClient.pathComponent(reviewID))")
  }
  func close(_ reviewID: String) async throws -> TerminalCodeReviewRun {
    try await api.authorized("/api/terminal/code-reviews/\(APIClient.pathComponent(reviewID))/close", method: "POST", retryUnauthorized: false)
  }
  func artifact(reviewID: String, artifact: TerminalCodeReviewReport.Artifact) async throws -> URL {
    struct Saved: Decodable { let url: URL }
    let value: Saved = try await api.authorized("/api/terminal/code-reviews/\(APIClient.pathComponent(reviewID))/artifacts/\(APIClient.pathComponent(artifact.artifactId))", download: { source in
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("code-review-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent((artifact.path as NSString).lastPathComponent)
      try FileManager.default.copyItem(at: source, to: url)
      return Saved(url: url)
    })
    return value.url
  }
}
