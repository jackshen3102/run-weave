import Foundation

extension APIClient {
  func diagnosticStatus() async throws -> DiagnosticStatus {
    try await authorized("/api/diagnostic-logs/status")
  }
  func startDiagnostics() async throws -> DiagnosticStatus {
    try await authorized("/api/diagnostic-logs/start", method: "POST", retryUnauthorized: false)
  }
  func stopDiagnostics(records: [DiagnosticRecord]) async throws -> DiagnosticResult {
    let data = try JSONEncoder().encode(records)
    return try await authorized(
      "/api/diagnostic-logs/stop", method: "POST",
      body: ["frontendLogs": try JSONSerialization.jsonObject(with: data)], retryUnauthorized: false
    )
  }
}
