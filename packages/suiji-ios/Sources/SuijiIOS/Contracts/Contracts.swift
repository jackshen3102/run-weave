import Foundation
public enum RecordKind: String, Codable, CaseIterable, Sendable { case note, task }
public enum TaskStatus: String, Codable, CaseIterable, Sendable { case open, done, archived }
public struct Attachment: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: String
  public let fileName: String
  public let mimeType: String
  public let byteSize: Int
  public var position: Int?
}
public struct SuijiRecord: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: RecordKind
  public let body: String
  public let tags: [String]?
  public let taskStatus: TaskStatus?
  public let version: Int
  public let createdAt: String
  public let updatedAt: String
  public let deletedAt: String?
  public let createdVia: String
  public let attachments: [Attachment]
}
public struct RecordResponse: Codable, Sendable { public let record: SuijiRecord }
struct TagDirectory: Decodable, Sendable { let items: [String] }
enum SuijiTags {
  static func normalize(_ values: [String]) throws -> [String] {
    guard values.count <= 2 else { throw MessageError(message: "最多 2 个标签") }
    let tags = values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard tags.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 20 && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else {
      throw MessageError(message: "标签须为 1–20 个字符，不能包含控制字符")
    }
    guard Set(tags).count == tags.count else { throw MessageError(message: "标签不能重复") }
    return tags
  }
}
public struct UploadResponse: Codable, Sendable { public let attachment: Attachment }
public struct RecordPage: Codable, Sendable { public let items: [SuijiRecord]; public let nextCursor: String? }
public struct Tokens: Codable, Sendable {
  public let accessToken: String
  public let refreshToken: String
  public let expiresIn: Int
  public let sessionId: String
  public let ownerId: String
  public let serverId: String
}
public struct Limits: Codable, Sendable {
  public let bodyScalars: Int
  public let attachmentBytes: Int
  public let imagesPerRecord: Int
  public let markdownPerRecord: Int
  public let defaultPageSize: Int
  public let maxPageSize: Int
}
public struct ServiceInfo: Codable, Sendable {
  public let protocolVersion: Int
  public let appVersion: String
  public let schemaVersion: Int
  public let ownerId: String
  public let serverId: String
  public let limits: Limits
  let ai: ReviewCapability?
}
public struct APIError: Error, Decodable, LocalizedError, Sendable {
  public struct Detail: Decodable, Sendable { public let currentVersion: Int? }
  public struct Body: Decodable, Sendable {
    public let code: String; public let message: String; public let retryable: Bool; public let details: Detail?
  }
  public let error: Body
  public let requestId: String
  public var errorDescription: String? { error.message }
  public var uncertain: Bool { ["DEPENDENCY_UNAVAILABLE", "IDEMPOTENCY_KEY_REUSED", "UNAUTHENTICATED", "RATE_LIMITED"].contains(error.code) }
}
struct MessageError: LocalizedError { let message: String; var errorDescription: String? { message } }
struct EmptyResponse: Decodable {}
