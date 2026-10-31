import Foundation

struct ScreenAnalysisSpan: Codable { let startMs: Int64; let endMs: Int64; let actor: String }
struct ScreenAnalysisEvidence: Codable {
    let id: String; let source: String; let occurredAtMs: Int64
    var captureID: String?; var provider: String?; var threadID: String?; var eventID: String?
    var kind: String?; var independentSuccess: Bool?
}
struct ScreenAnalysisCard: Codable, Identifiable {
    var id: String { cardID }
    let cardID: String; let matterID: String; let revision: Int
    let title: String; let summary: String; let detail: String; let actor: String; let state: String
    let projectID: String?; let spans: [ScreenAnalysisSpan]; let evidenceIDs: [String]; let updatedAt: Int64
}
struct ScreenAnalysisResultCard: Codable {
    let cardID: String?; let matterID: String?; let baseRevision: Int?
    let title: String; let summary: String; let detail: String; let actor: String; let state: String
    let projectID: String?; let spans: [ScreenAnalysisSpan]; let evidenceIDs: [String]
}
struct ScreenAnalysisRewriteSpan: Codable { let startMs: Int64; let endMs: Int64 }
struct ScreenAnalysisReplacement: Codable { let cardID: String; let baseRevision: Int; let targetIndexes: [Int] }
struct ScreenAnalysisResult: Codable {
    let cards: [ScreenAnalysisResultCard]; let observation: String
    var rewriteSpan: ScreenAnalysisRewriteSpan? = nil; var replacements: [ScreenAnalysisReplacement]? = nil
}
struct ScreenAnalysisManifest: Codable {
    let batchID: String; let deviceID: String; let day: String; let inputHash: String; let promptVersion: String
    let startMs: Int64; let endMs: Int64; let captures: [ScreenRecordingCapture]; let intervals: [ScreenRecordingInterval]
    let context: [ScreenAnalysisCard]; let evidence: [ScreenAnalysisEvidence]; let agentCoverage: String
}
struct ScreenAnalysisClaim: Codable {
    let manifest: ScreenAnalysisManifest; let workerID: String; let generation: Int; let expiresAt: Int64; let attempt: Int
}
struct ScreenAnalysisReceipt: Codable { let operationID: String; let batchID: String; let revision: Int; let cardIDs: [String] }
struct ScreenAnalysisStatus: Codable {
    let analysisVersion = 1; let deviceID: String; let state: String; let revision: Int
    let queueCount: Int; let failedCount: Int; let latestSuccessMs: Int64?; let processedThroughMs: Int64?; let days: [String]?
    let agentCoverage = "unknown"
}
struct ScreenAnalysisMissing: Codable { let startMs: Int64; let endMs: Int64; let actor = "person"; let reason: String; var batchID: String? = nil }
struct ScreenAnalysisExport: Codable {
    let schemaVersion = 1; let deviceID: String; let day: String; let timeZone = "Asia/Shanghai"
    let snapshotID: String; let revision: Int; let generatedAt: Int64; let sourceReadAt: Int64
    let coverage: String; let missingIntervals: [ScreenAnalysisMissing]; let cards: [ScreenAnalysisCard]
    let evidence: [ScreenAnalysisEvidence]; let summary: String; var contentHash: String
}
