import Foundation
public enum WorkStatus: String, Codable, CaseIterable, Sendable {
  case progress, discussed, documented, attempted
  case agentReported = "agent-reported"
  case verified
  var label: String { switch self { case .progress: "有进展"; case .discussed: "讨论"; case .documented: "已记录"; case .attempted: "尝试"; case .agentReported: "Agent 反馈"; case .verified: "已验证" } }
}
public struct WorkFact: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let eventKey: String
  public let workDate: String
  public let timeZone: String
  public let title: String
  public let statement: String
  public let status: WorkStatus
  public let project: String?
  public let version: Int
  public let createdAt: String
  public let updatedAt: String
  public let createdVia: String
  public let manualFields: [String]
}
public struct WorkDay: Codable, Equatable, Sendable { public let date: String; public let count: Int; public let coverage: String }
public struct WorkFactPage: Codable, Sendable { public let items: [WorkFact]; public let days: [WorkDay]; public let nextCursor: String?; public let feedRevision: String }
struct WorkFactResponse: Codable, Sendable { let fact: WorkFact }
struct WorkFactsResponse: Codable, Sendable { let facts: [WorkFact] }
struct WorkFactInput: Codable, Equatable, Sendable {
  var workDate: String
  var title: String
  var statement: String
  var status: WorkStatus
  var project: String?
  var dictionary: [String: Any] { ["workDate": workDate, "title": title, "statement": statement, "status": status.rawValue, "project": project as Any? ?? NSNull()] }
  init(_ fact: WorkFact) { workDate = fact.workDate; title = fact.title; statement = fact.statement; status = fact.status; project = fact.project }
  init(date: String) { workDate = date; title = ""; statement = ""; status = .progress; project = nil }
}
struct WorkRestoreItem: Codable, Sendable { let id: String; let expectedVersion: Int; let project: String?
  var dictionary: [String: Any] { ["id": id, "expectedVersion": expectedVersion, "project": project as Any? ?? NSNull()] }
}
