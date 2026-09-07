import Foundation

struct ReviewCapability: Codable, Sendable { let enabled: Bool; let provider: String }
struct ReviewScope: Codable, Hashable, Sendable {
  let kind: String
  let recordId: String?
  static let all = ReviewScope(kind: "all", recordId: nil)
  static let open = ReviewScope(kind: "open", recordId: nil)
  static func record(_ id: String) -> ReviewScope { ReviewScope(kind: "record", recordId: id) }
}
struct ReviewInput: Encodable, Sendable {
  struct Message: Encodable, Sendable { let role: String; let text: String }
  let question: String
  let scope: ReviewScope
  let history: [Message]
}
struct ReviewCitation: Codable, Identifiable, Sendable {
  struct File: Codable, Sendable { let id: String; let fileName: String; let mimeType: String; let offset: Int? }
  let recordId: String
  let version: Int
  let kind: RecordKind
  let taskStatus: TaskStatus?
  let createdAt: String
  let quote: String
  let attachment: File?
  var id: String { recordId + ":\(version):" + (attachment?.id ?? "") + quote }
}
struct ReviewAnswer: Codable, Sendable {
  struct Coverage: Codable, Sendable {
    let mode: String; let scope: ReviewScope; let listedRecords: Int; let readRecords: Int
    let attachmentReads: Int; let semanticIndex: Bool; let externalLinks: Bool
  }
  let text: String
  let citations: [ReviewCitation]
  let coverage: Coverage
}
struct SuijiReview: Codable, Identifiable, Sendable {
  let id: String
  let status: String
  let createdAt: String
  let answer: ReviewAnswer?
  let error: String?
}
