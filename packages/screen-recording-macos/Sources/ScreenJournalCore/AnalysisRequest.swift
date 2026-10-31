import Foundation

struct AnalysisRequest: Decodable {
    var q: String?; var from: String?; var to: String?
    var threadID: String?; var expectedCursor: String?; var coverage: String?; var events: [AnalysisAgentEvent]?
    var workerID: String?; var expectedDeviceID: String?; var effectiveFrom: Int64?
    var batchID: String?; var generation: Int?; var operationID: String?; var inputHash: String?
    var result: AnalysisResult?; var code: String?; var captureID: String?; var day: String?
    var snapshotRevision: Int?; var expectedRevision: Int?; var cardID: String?; var cursor: String?; var limit: Int?
}
struct AnalysisCardsPage: Encodable { let items: [AnalysisCard]; let revision: Int; let nextCursor: String? }
