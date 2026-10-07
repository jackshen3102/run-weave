import Foundation

extension APIClient {
  func developmentResources() async throws -> DevelopmentResourcesSnapshot {
    try await authorized("/api/dev-resources", requestTimeout: 75)
  }

  func releaseDevelopmentResource(_ resource: DevelopmentResource, requestID: String)
    async throws -> DevelopmentResourceReleaseResult
  {
    guard resource.canRelease, let action = resource.release.action,
      let version = resource.ownershipVersion else { throw APIError.invalidResponse }
    return try await authorized(
      "/api/dev-resources/\(Self.pathComponent(resource.id))/release", method: "POST",
      body: ["action": action, "expectedOwnershipVersion": version, "idempotencyKey": requestID],
      retryUnauthorized: false, requestTimeout: 75,
      decodeError: { _, data in try? JSONDecoder().decode(DevelopmentResourceFailure.self, from: data) })
  }
}
