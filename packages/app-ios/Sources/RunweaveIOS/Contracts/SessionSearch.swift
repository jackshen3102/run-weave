import Foundation

// Source: packages/shared/src/session-search.ts. The Backend owns the native transcript index.
struct SessionSearchLocation: Decodable {
  let path: String
  let line: Int
  let byteOffset: Int
  let byteLength: Int
  let sha256: String
}
struct SessionSearchHit: Decodable, Identifiable {
  let id: String
  let sessionId: String
  let threadId: String
  let provider: String
  let projectPath: String
  let repositoryId: String?
  let title: String
  let origin: String
  let occurredAt: String?
  let kind: String
  let text: String
  let callId: String?
  let toolName: String?
  let location: SessionSearchLocation
}
struct SessionSearchSourceStatus: Decodable, Identifiable {
  let provider: String
  let status: String
  let files: Int
  let sessions: Int
  let indexedAt: String?
  let issues: [String]
  var id: String { provider }
}
struct SessionSearchStatus: Decodable {
  let node: String
  let state: String
  let generation: Int
  let lastScanAt: String?
  let sources: [SessionSearchSourceStatus]
}
struct SessionSearchPage: Decodable {
  let query: String
  let level: String
  let hits: [SessionSearchHit]
  let nextCursor: String?
  let partial: Bool
  let coverage: SessionSearchStatus
}
struct SessionSearchContext: Decodable {
  let hit: SessionSearchHit
  let records: [SessionSearchHit]
  let paired: [SessionSearchHit]
  let sourceState: String
  let partial: Bool
}
