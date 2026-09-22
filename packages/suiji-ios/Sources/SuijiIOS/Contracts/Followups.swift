import Foundation

public struct FollowupSource: Codable, Equatable, Sendable {
  public let actor: String
  public let agentName: String?
  public let sessionId: String?
}
public struct FollowupLatest: Codable, Equatable, Sendable {
  public let id: String
  public let sequence: Int
  public let excerpt: String
  public let createdAt: String
  public let source: FollowupSource
}
public struct FollowupSummary: Codable, Equatable, Sendable {
  public let count: Int
  public let latest: FollowupLatest?
}
public struct SuijiFollowup: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let recordId: String
  public let sequence: Int
  public let body: String
  public let createdAt: String
  public let source: FollowupSource
  public let attachments: [Attachment]
}
struct FollowupPage: Codable, Sendable { let items: [SuijiFollowup]; let nextCursor: String? }
struct FollowupResponse: Codable, Sendable { let followup: SuijiFollowup; let followupSummary: FollowupSummary }
struct FollowupFeatures: Codable, Sendable { let followups: Bool }
func mergeSuijiRecord(_ old: SuijiRecord, _ new: SuijiRecord) -> SuijiRecord {
  var value = old.version > new.version ? old : new
  value.followupSummary = (old.followupSummary?.latest?.sequence ?? 0) > (new.followupSummary?.latest?.sequence ?? 0) ? old.followupSummary : new.followupSummary ?? old.followupSummary
  return value
}
func suijiHandoff(endpoint: String, info: ServiceInfo, recordID: String) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: ["format": "suiji-handoff-v1", "endpoint": endpoint, "serverId": info.serverId, "ownerId": info.ownerId, "recordId": recordID], options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
  return "使用随记 Skill 处理这条记录。先读取最新原文、全部跟进和相关附件，按我本次要求执行；成功后只追加最终成果，不记录过程或失败。未经我确认，不标记完成。\n" + String(decoding: data, as: UTF8.self)
}
