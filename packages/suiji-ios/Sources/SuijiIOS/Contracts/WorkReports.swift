import Foundation
public struct WorkReportSource: Codable, Equatable, Sendable { public let id: String; public let version: Int }
public struct WorkReport: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let from: String
  public let to: String
  public let title: String
  public let body: String
  public let timeZone: String
  public let kind: String
  public let sourceFacts: [WorkReportSource]
  public let days: [WorkDay]
  public let basedOnFeedRevision: String
  public let version: Int
  public let manuallyEdited: Bool
  public let createdAt: String
  public let updatedAt: String
}
struct WorkReportResponse: Codable, Sendable { let report: WorkReport }
