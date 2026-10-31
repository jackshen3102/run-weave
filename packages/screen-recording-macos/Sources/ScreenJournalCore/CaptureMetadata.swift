import Foundation

struct CaptureMetadata {
    let id: String
    let sessionID: String
    let sequence: Int
    let capturedAt: Date
    let timezoneOffset: Int
    let displayID: UInt32
    let applicationID: String?
    let idleSeconds: Double?
    let privacyPlaceholder: Bool
}
struct SegmentRecord {
    let id: String
    let path: String
    let state: String
    let start: Double
    let end: Double
    let width: Int
    let height: Int
    let displayID: UInt32
    let frames: Int
}
struct RuntimeStatus: Codable {
    var pid = ProcessInfo.processInfo.processIdentifier
    var updatedAt = Date().timeIntervalSince1970
    var state = "stopped"
    var reason = ""
    var desiredRecording = false
    var generation = 0
    var inFlight = false
    var expectedTicks = 0
    var successfulSamples = 0
    var busySkipped = 0
    var discarded = 0
    var failedSamples = 0
    var privacySamples = 0
    var lastSuccess: Double?
    var diskBytes: Int64 = 0
    var validation = false
    var maxBytesOverride: Int64?
    var freeBytesOverride: Int64?
    var displayState: String {
        switch state {
        case "stopped": return "已暂停"
        case "starting": return "准备记录"
        case "recording": return "记录中"
        case "pausedSystem": return "系统暂停"
        case "blockedPermission": return "需要屏幕录制权限"
        case "blockedStorage": return "存储受限"
        default: return "记录失败"
        }
    }
    var privacyRevision = 1
    var sessionID = ""
}
