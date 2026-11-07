import Foundation
public struct Tokens: Codable, Sendable {
  public let accessToken: String
  public let refreshToken: String
  public let expiresIn: Int
  public let sessionId: String
  public let ownerId: String
  public let serverId: String
}
public struct APIError: Error, Decodable, LocalizedError, Sendable {
  public struct Detail: Decodable, Sendable { public let currentVersion: Int?; public let currentFeedRevision: String? }
  public struct Body: Decodable, Sendable {
    public let code: String; public let message: String; public let retryable: Bool; public let details: Detail?
  }
  public let error: Body
  public let requestId: String
  public var errorDescription: String? { error.message }
  public var uncertain: Bool { ["DEPENDENCY_UNAVAILABLE", "IDEMPOTENCY_KEY_REUSED", "UNAUTHENTICATED", "RATE_LIMITED"].contains(error.code) }
}
public enum ConnectionEnvironment: String, Codable, CaseIterable, Identifiable, Sendable {
  case production, development
  public var id: String { rawValue }
  public var label: String { self == .production ? "正式" : "开发" }
  // Preserve the existing production credential and draft keys when upgrading.
  public func scoped(_ value: String) -> String { self == .production ? value : "development\n" + value }
}


public struct CaptureError: LocalizedError { public let message: String; public init(_ message: String) { self.message = message }; public var errorDescription: String? { message } }

public struct CaptureServiceInfo: Decodable, Sendable {
  public struct Features: Decodable, Sendable { public let browse: Bool?; public let materials: Bool? }
  public let protocolVersion: Int
  public let serverId: String
  public let ownerId: String
  public let features: Features?
}
