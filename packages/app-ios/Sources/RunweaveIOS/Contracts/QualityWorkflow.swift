import Foundation

/// Mirrors @runweave/shared/quality-workflow v1. No request text or credentials.
struct QualityEvent: Codable, Sendable {
  var seq: Int
  let at: String
  let action: String
  let stage: String
  let operationId: String
  let launchId: String
  let elapsedMs: Int
  let appVersion: String
  let buildId: String
  let sourceRevision: String
  let sourceState: String
  let terminalSessionId: String?
  let attemptId: String?
  let relatedOperationId: String?
  let failureCode: String?
  let status: Int?
  let closeCode: Int?
}
struct QualityRange: Codable, Sendable { var from: Int; var through: Int; let reason: String }
struct QualityBatch: Codable, Sendable {
  let schemaVersion = 1
  let backendId: String
  let sourceId: String
  let streamId: String
  let client = "ios"
  let uploadedAt: String
  let events: [QualityEvent]
  let droppedRanges: [QualityRange]
}
struct QualityCapabilities: Decodable, Sendable { let enabled: Bool; let schemaVersion: Int; let backendId: String? }
struct QualityReceipt: Decodable, Sendable { let ackThrough: Int; let acceptedCount: Int; let duplicateCount: Int; let receivedAt: String }
