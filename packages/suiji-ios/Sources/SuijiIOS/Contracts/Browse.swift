import Foundation
struct BrowseSource: Codable, Equatable, Sendable { var provider: String; var displayName: String; var connectionId: String? }
struct BrowseContentState: Codable, Equatable, Sendable { let state: String; let reason: String? }
struct BrowseEntry: Codable, Identifiable, Equatable, Sendable {
  let id: String; let captureId: String; let version: Int; let browseDate: String; let occurredAt: String?; let capturedAt: String
  var title: String; var body: String?; var excerpt: String?; var userNote: String; var source: BrowseSource
  let contentType: String; let captureMethod: String; let sourceUrl: String?; let contentState: BrowseContentState
  let contentHash: String; let deletedAt: String?; let attachments: [Attachment]
}
struct BrowseDayCount: Codable, Sendable { let date: String; let count: Int }
struct BrowsePage: Codable, Sendable { let items: [BrowseEntry]; let dayCounts: [BrowseDayCount]; let nextCursor: String?; let browseRevision: String; let sources: [BrowseSource]?; let digests: [BrowseDigest]? }
struct BrowseEntryRef: Codable, Sendable { let id: String; let version: Int; let hash: String }
struct BrowseDigest: Codable, Identifiable, Sendable { let id: String; let date: String; let connectionId: String; let title: String; let body: String; let version: Int; let state: String; let entryRefs: [BrowseEntryRef]; let inputRevision: String }
struct BrowseCoverage: Codable, Sendable { let state: String; let pages: Int; let metadata: Int; let content: Int; let errors: [String] }
struct BrowseConnection: Codable, Identifiable, Sendable { let id: String; let provider: String; let externalAccountId: String; let machine: String; let profile: String; let group: String; let state: String; let lastSuccessAt: String?; let latestCoverage: BrowseCoverage? }
struct BrowseEntryResponse: Codable, Sendable { let entry: BrowseEntry }
struct BrowseConnections: Codable, Sendable { let items: [BrowseConnection] }
struct BrowseHistory: Codable, Sendable { let revisions: [BrowseLegacyRevision]; let followups: [SuijiFollowup] }
struct BrowseLegacyRevision: Codable, Sendable { let version: Int; let snapshot: SuijiRecord }
