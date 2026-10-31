import Foundation
import CryptoKit

struct AnalysisSpan: Codable { let startMs: Int64; let endMs: Int64; let actor: String }
struct AnalysisEvidence: Codable {
    let id: String; let source: String; let occurredAtMs: Int64
    var captureID: String?; var provider: String?; var threadID: String?; var eventID: String?
    var text: String?; var kind: String?; var independentSuccess: Bool?
}
struct AnalysisCard: Codable, Identifiable {
    var id: String { cardID }
    let cardID: String; let matterID: String; let revision: Int
    let title: String; let summary: String; let detail: String; let actor: String; let state: String
    let projectID: String?; let spans: [AnalysisSpan]; let evidenceIDs: [String]; let updatedAt: Int64
}
struct AnalysisResultCard: Codable {
    let cardID: String?; let matterID: String?; let baseRevision: Int?
    let title: String; let summary: String; let detail: String; let actor: String; let state: String
    let projectID: String?; let spans: [AnalysisSpan]; let evidenceIDs: [String]
}
struct AnalysisRewriteSpan: Codable { let startMs: Int64; let endMs: Int64 }
struct AnalysisReplacement: Codable { let cardID: String; let baseRevision: Int; let targetIndexes: [Int] }
struct AnalysisResult: Codable {
    let cards: [AnalysisResultCard]; let observation: String
    var rewriteSpan: AnalysisRewriteSpan? = nil; var replacements: [AnalysisReplacement]? = nil
}
struct AnalysisManifest: Codable {
    let batchID: String; let deviceID: String; let day: String; let inputHash: String; let promptVersion: String
    let startMs: Int64; let endMs: Int64; let captures: [JournalCapture]; let intervals: [JournalInterval]
    let context: [AnalysisCard]; let evidence: [AnalysisEvidence]; let agentCoverage: String
}
struct AnalysisClaim: Codable {
    let manifest: AnalysisManifest; let workerID: String; let generation: Int; let expiresAt: Int64; let attempt: Int
}
struct AnalysisReceipt: Codable { let operationID: String; let batchID: String; let revision: Int; let cardIDs: [String] }
struct AnalysisStatus: Codable {
    let analysisVersion = 1; let deviceID: String; let state: String; let revision: Int
    let queueCount: Int; let failedCount: Int; let latestSuccessMs: Int64?; let processedThroughMs: Int64?; let days: [String]
    let agentCoverage = "unknown"
}
struct AnalysisMissing: Codable { let startMs: Int64; let endMs: Int64; let actor = "person"; let reason: String; var batchID: String? = nil }
struct AnalysisExport: Codable {
    let schemaVersion = 1; let deviceID: String; let day: String; let timeZone = "Asia/Shanghai"
    let snapshotID: String; let revision: Int; let generatedAt: Int64; let sourceReadAt: Int64
    let coverage: String; let missingIntervals: [AnalysisMissing]; let cards: [AnalysisCard]
    let evidence: [AnalysisEvidence]; let summary: String; var contentHash: String
}
func analysisJSON<T: Encodable>(_ value: T) throws -> String {
    let e = JSONEncoder(); e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try e.encode(value), as: UTF8.self)
}
func analysisHash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
func analysisDay(_ ms: Int64) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

struct AnalysisAgentEvent: Codable {
    let id: String; let provider: String; let threadID: String; let eventID: String; let projectID: String?
    let occurredAtMs: Int64; let kind: String; let text: String; let derived: Bool; let independentSuccess: Bool
}
