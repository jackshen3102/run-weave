import Foundation

extension APIClient {
  private nonisolated func previewPath(
    _ projectID: String, _ resource: String, _ query: [String: String] = [:]
  ) -> String {
    var components = URLComponents()
    components.path = "/api/terminal/project/\(projectID)/preview/\(resource)"
    // Project IDs can include worktree punctuation; encode the path component independently.
    let path = "/api/terminal/project/\(Self.pathComponent(projectID))/preview/\(resource)"
    components.queryItems = query.sorted { $0.key < $1.key }.map {
      URLQueryItem(name: $0.key, value: $0.value)
    }
    return path + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
  }
  func previewSnapshot<T: Decodable>(
    projectID: String, resource: String, query: [String: String] = [:],
    decode: ((Data) throws -> T)? = nil
  ) -> T? {
    guard hasCredentials(),
      let data = previewCache.value(previewPath(projectID, resource, query), freshOnly: false)
    else { return nil }
    return try? (decode ?? { try JSONDecoder().decode(T.self, from: $0) })(data)
  }
  func directory(projectID: String, path: String, force: Bool = false) async throws
    -> PreviewDirectory
  {
    try await cachedPreview(
      previewPath(projectID, "directory", ["path": path, "limit": "400"]), force: force)
  }
  func searchFiles(projectID: String, query: String, force: Bool = false) async throws
    -> PreviewSearch
  {
    try await cachedPreview(
      previewPath(projectID, "files/search", ["q": query, "limit": "50"]), force: force)
  }
  func changes(projectID: String, force: Bool = false) async throws -> PreviewChanges {
    try await cachedPreview(previewPath(projectID, "git-changes"), force: force)
  }
  func file(projectID: String, path: String) async throws -> PreviewFile {
    try await cachedPreview(previewPath(projectID, "file", ["path": path]))
  }
  func diff(projectID: String, path: String, kind: String) async throws -> PreviewDiff {
    try await cachedPreview(previewPath(projectID, "file-diff", ["path": path, "kind": kind]))
  }
  func asset(projectID: String, path: String) async throws -> Data {
    try await cachedPreview(previewPath(projectID, "asset", ["path": path]), decode: { $0 })
  }
}
