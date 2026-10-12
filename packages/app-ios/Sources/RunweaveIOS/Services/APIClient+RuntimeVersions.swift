import Foundation

extension APIClient {
  func runtimeVersions() async throws -> RuntimeVersionSnapshot {
    try await authorized("/api/runtime-status", requestTimeout: 10)
  }
}
