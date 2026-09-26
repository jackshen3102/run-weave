import Foundation

extension APIClient {
  func configuration() async throws -> ConfigurationSnapshot {
    try await authorized("/api/configuration", method: "GET")
  }
  func saveConfiguration(_ current: ConfigurationSnapshot, changes: [String: Any]) async throws -> ConfigurationSnapshot {
    guard let revision = current.savedRevision, let digest = current.digest else { throw APIError.invalidResponse }
    let next: ConfigurationSnapshot = try await authorized("/api/configuration", method: "PATCH", body: [
      "expectedRevision": revision, "expectedDigest": digest,
      "expectedEnvironment": ["kind": current.environment.kind, "instanceId": current.environment.instanceId],
      "changes": changes,
    ], retryUnauthorized: false)
    guard next.environment == current.environment else { throw APIError.invalidResponse }
    return next
  }
}
