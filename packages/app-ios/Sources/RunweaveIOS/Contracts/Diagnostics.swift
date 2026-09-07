import Foundation

struct DiagnosticRecord: Codable {
  let at: String
  let source: String
  let message: String
  let details: [String: String]
}
struct DiagnosticStatus: Decodable {
  let status: String
  let startedAt: String?
}
struct DiagnosticResult: Decodable {
  let startedAt: String
  let stoppedAt: String
  let files: Files?
  struct Files: Decodable {
    let dir: String?
    let logsJsonl: String?
  }
}
