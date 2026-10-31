import Foundation

struct ScreenRecordingReadError: Error, LocalizedError, Codable {
    let code: String
    let message: String
    let retryable: Bool
    var errorDescription: String? { message }
    var httpStatus: Int {
        switch code {
        case "INVALID_ARGUMENT": return 400
        case "NOT_FOUND": return 404
        case "CATALOG_CHANGED", "VIEW_EXPIRED", "INCOMPATIBLE": return 409
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
struct ScreenRecordingApplication: Codable, Equatable { let id: String?; let name: String? }
struct ScreenRecordingCapture: Codable, Identifiable, Equatable {
    let id: String
    let sessionID: String
    let sequence: Int
    let capturedAtMs: Int64
    let timezoneOffsetSeconds: Int
    let displayID: UInt32
    let frontmostApplication: ScreenRecordingApplication?
    let privacyPlaceholder: Bool
    let availableUntilMs: Int64
}
struct ScreenRecordingInterval: Codable, Equatable {
    let startMs: Int64
    let endMs: Int64
    let kind: String
}
struct ScreenRecordingRange: Codable, Identifiable, Equatable {
    var id: String { rangeID }
    let rangeID: String
    let startMs: Int64
    let endMs: Int64
    let displayID: UInt32
    let sampleCount: Int
    let previewCaptureID: String?
    let state: String
}
struct ScreenRecordingDay: Codable, Identifiable, Equatable {
    var id: String { day }
    let day: String
    let startMs: Int64
    let endMs: Int64
}
struct ScreenRecordingPage<T: Codable>: Codable {
    let items: [T]
    let catalogRevision: String
    let nextCursor: String?
}
struct ScreenRecordingView: Codable {
    let viewID: String
    let serverEpoch: String
    let deviceID: String
    let range: ScreenRecordingRange
    let captures: [ScreenRecordingCapture]
    let intervals: [ScreenRecordingInterval]
    let expiresAt: Int64
}
struct ScreenRecordingAvailability: Codable {
    let checkedAt: Int64
    let expiresAt: Int64
    let invalidCaptureIDs: [String]
    let intervals: [ScreenRecordingInterval]
    let viewState: String
}
struct ScreenRecordingStatus: Codable {
    let version: Int
    let availability: String
    let deviceID: String
    let deviceName: String
    let timeZone: String
    let serverEpoch: String
    let catalogRevision: String
    let captureState: String
    let retentionDays: Int
    let days: [ScreenRecordingDay]
    let latestReadyMs: Int64?
    let hasPending: Bool
    private enum CodingKeys: String, CodingKey { case version, availability, deviceID, deviceName, timeZone, serverEpoch, catalogRevision, captureState, retentionDays, days, latestReadyMs, hasPending }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version); availability = try c.decode(String.self, forKey: .availability)
        deviceID = try c.decodeIfPresent(String.self, forKey: .deviceID) ?? ""
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName) ?? ""
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? ""
        serverEpoch = try c.decodeIfPresent(String.self, forKey: .serverEpoch) ?? ""
        catalogRevision = try c.decodeIfPresent(String.self, forKey: .catalogRevision) ?? ""
        captureState = try c.decodeIfPresent(String.self, forKey: .captureState) ?? ""
        retentionDays = try c.decodeIfPresent(Int.self, forKey: .retentionDays) ?? 0
        days = try c.decodeIfPresent([ScreenRecordingDay].self, forKey: .days) ?? []
        latestReadyMs = try c.decodeIfPresent(Int64.self, forKey: .latestReadyMs)
        hasPending = try c.decodeIfPresent(Bool.self, forKey: .hasPending) ?? false
    }
}
enum ScreenRecordingVariant: String, Codable { case thumb, preview, full
    var height: Int? { self == .thumb ? 180 : self == .preview ? 540 : nil }
}
func screenRecordingNowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

