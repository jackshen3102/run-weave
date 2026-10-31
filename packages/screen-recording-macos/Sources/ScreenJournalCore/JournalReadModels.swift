import Foundation

struct JournalReadError: Error, LocalizedError, Codable {
    let code: String
    let message: String
    let retryable: Bool
    var errorDescription: String? { message }
    var httpStatus: Int {
        switch code {
        case "INVALID_ARGUMENT": return 400
        case "NOT_FOUND": return 404
        case "CONFLICT", "LEASE_LOST", "CATALOG_CHANGED", "VIEW_EXPIRED", "INCOMPATIBLE": return 409
        case "FRAME_GONE": return 410
        case "PRIVATE_FRAME": return 422
        case "BUSY": return 429
        case "TIMEOUT": return 504
        default: return 503
        }
    }
    init(_ code: String, _ message: String = "", retryable: Bool = false) {
        self.code = code; self.message = message.isEmpty ? code : message; self.retryable = retryable
    }
}
struct JournalApplication: Codable, Equatable { let id: String?; let name: String? }
struct JournalCapture: Codable, Identifiable, Equatable {
    let id: String
    let sessionID: String
    let sequence: Int
    let capturedAtMs: Int64
    let timezoneOffsetSeconds: Int
    let displayID: UInt32
    let frontmostApplication: JournalApplication?
    let privacyPlaceholder: Bool
    let availableUntilMs: Int64
    var idleSeconds: Double? = nil
}
struct JournalInterval: Codable, Equatable {
    let startMs: Int64
    let endMs: Int64
    let kind: String
}
struct JournalRange: Codable, Identifiable, Equatable {
    var id: String { rangeID }
    let rangeID: String
    let startMs: Int64
    let endMs: Int64
    let displayID: UInt32
    let sampleCount: Int
    let previewCaptureID: String?
    let state: String
}
struct JournalDay: Codable, Identifiable, Equatable {
    var id: String { day }
    let day: String
    let startMs: Int64
    let endMs: Int64
}
struct JournalPage<T: Codable>: Codable {
    let items: [T]
    let catalogRevision: String
    let nextCursor: String?
}
struct JournalView: Codable {
    let viewID: String
    let serverEpoch: String
    let deviceID: String
    let range: JournalRange
    let captures: [JournalCapture]
    let intervals: [JournalInterval]
    let expiresAt: Int64
}
struct JournalAvailability: Codable {
    let checkedAt: Int64
    let expiresAt: Int64
    let invalidCaptureIDs: [String]
    let intervals: [JournalInterval]
    let viewState: String
}
struct JournalStatus: Codable {
    let analysisVersion = 1
    let version: Int
    let availability: String
    let deviceID: String
    let deviceName: String
    let timeZone: String
    let serverEpoch: String
    let catalogRevision: String
    let captureState: String
    let retentionDays: Int
    let days: [JournalDay]
    let latestReadyMs: Int64?
    let hasPending: Bool
}
enum JournalVariant: String, Codable { case thumb, preview, full
    var height: Int? { self == .thumb ? 180 : self == .preview ? 540 : nil }
}
func journalNowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

// Internal locations are deliberately not serialized into the HTTP contract.
struct JournalIndexedCapture {
    let capture: JournalCapture
    let segmentID: String
    let frameIndex: Int
    let width: Int
    let height: Int
    let path: String
}
struct JournalRangeBounds {
    let sessionID: String
    let firstSequence: Int
    let lastSequence: Int
}
struct JournalCatalog {
    let revision: String
    let deviceID: String
    let days: [JournalDay]
    let ranges: [JournalRange]
    let members: [String: JournalRangeBounds]
    let intervals: [JournalInterval]
    let hasPending: Bool
}
