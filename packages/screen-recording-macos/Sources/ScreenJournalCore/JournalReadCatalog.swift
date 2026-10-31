import AppKit
import CryptoKit

struct JournalReadCatalog {
    static func load(_ db: RecordStore, settings: RecordingSettings, now: Int64 = journalNowMs(), zone: TimeZone = .current) throws -> JournalCatalog {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = zone; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        let cutoff = Double(now) / 1000 - Double(settings.retentionDays) * 86400
        // Directory discovery retains range boundaries, not every capture. The
        // indexed session/sequence scan limits transient row memory to 900 frames.
        let sessions = try db.rows("""
            SELECT ss.id FROM sessions ss WHERE EXISTS (
                SELECT 1 FROM captures c JOIN segments s ON s.id=c.segment_id
                WHERE c.session_id=ss.id AND s.state='ready' AND s.started>=?)
            ORDER BY ss.started,ss.id
            """, [cutoff])
        var members: [String: JournalRangeBounds] = [:]
        var ranges: [JournalRange] = []
        var days: [Int64: JournalDay] = [:]
        var hash = SHA256()
        for sessionRow in sessions {
            guard let session = sessionRow["id"] else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            var after = Int.min
            var firstID: String?, firstSequence = 0, lastSequence = 0
            var startMs: Int64 = 0, endMs: Int64 = 0
            var display: UInt32 = 0, count = 0
            var previewID: String?, previousWindow: Date?
            func finish() {
                guard let id = firstID else { return }
                let key = "r-" + id
                members[key] = JournalRangeBounds(sessionID: session, firstSequence: firstSequence, lastSequence: lastSequence)
                ranges.append(JournalRange(rangeID: key, startMs: startMs, endMs: endMs, displayID: display,
                    sampleCount: count, previewCaptureID: previewID, state: "ready"))
                firstID = nil; previewID = nil; count = 0
            }
            while true {
                let rows = try db.rows("""
                    SELECT c.id,c.sequence,c.captured_ms,c.display_id,c.privacy_placeholder,c.segment_id
                    FROM captures c JOIN segments s ON s.id=c.segment_id
                    WHERE c.session_id=? AND c.sequence>? AND s.state='ready' AND s.started>=?
                    ORDER BY c.sequence LIMIT 900
                    """, [session, after, cutoff])
                if rows.isEmpty { break }
                for row in rows {
                    guard let id = row["id"], let sequence = Int(row["sequence"] ?? ""),
                          let ms = Int64(row["captured_ms"] ?? ""), let nextDisplay = UInt32(row["display_id"] ?? "") else { throw JournalReadError("MEDIA_UNAVAILABLE") }
                    after = sequence
                    let date = Date(timeIntervalSince1970: Double(ms) / 1000)
                    guard let dayInterval = calendar.dateInterval(of: .day, for: date), let hour = calendar.dateInterval(of: .hour, for: date) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
                    let dayStart = Int64(dayInterval.start.timeIntervalSince1970 * 1000)
                    if days[dayStart] == nil {
                        days[dayStart] = JournalDay(day: formatter.string(from: date), startMs: dayStart, endMs: Int64(dayInterval.end.timeIntervalSince1970 * 1000))
                    }
                    let minute = calendar.component(.minute, from: date)
                    let window = hour.start.addingTimeInterval(Double((minute / 15) * 15 * 60))
                    if firstID != nil && (display != nextDisplay || ms < endMs || window != previousWindow || count >= 900) { finish() }
                    if firstID == nil { firstID = id; firstSequence = sequence; startMs = ms; display = nextDisplay }
                    if previewID == nil && row["privacy_placeholder"] != "1" { previewID = id }
                    lastSequence = sequence; endMs = ms; count += 1; previousWindow = window
                    hash.update(data: Data("\(id):\(row["segment_id"] ?? ""):\(ms)|".utf8))
                }
            }
            finish()
        }
        ranges.sort { $0.startMs == $1.startMs ? $0.rangeID < $1.rangeID : $0.startMs < $1.startMs }
        let events = try db.rows("SELECT state,reason,started,ended FROM state_events WHERE ended>=? ORDER BY id", [cutoff])
        let intervals = events.compactMap { row -> JournalInterval? in
            guard let start = Double(row["started"] ?? ""), let end = Double(row["ended"] ?? ""), end > start else { return nil }
            let kind: String
            switch row["state"] {
            case "pausedSystem": kind = "systemInactive"
            case "stopped": kind = "paused"
            case "gap", "failed", "blockedPermission", "blockedStorage": kind = "error"
            default: return nil
            }
            return JournalInterval(startMs: Int64(start * 1000), endMs: Int64(end * 1000), kind: kind)
        }
        // Hash the complete membership and availability semantics, not just a row count.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        hash.update(data: Data((String(settings.retentionDays) + zone.identifier).utf8))
        hash.update(data: try encoder.encode(intervals))
        let revision = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return JournalCatalog(revision: revision, deviceID: try db.scalar("SELECT id FROM device LIMIT 1") ?? "unknown",
            days: days.values.sorted { $0.startMs > $1.startMs }, ranges: ranges, members: members, intervals: intervals,
            hasPending: (Int(try db.scalar("SELECT COUNT(*) FROM segments WHERE state='writing'") ?? "0") ?? 0) > 0)
    }
    static func frames(_ bounds: JournalRangeBounds, database db: RecordStore, settings: RecordingSettings) throws -> [JournalIndexedCapture] {
        let rows = try db.rows("""
            SELECT c.*,s.width,s.height,s.path,s.started AS segment_started FROM captures c JOIN segments s ON s.id=c.segment_id
            WHERE c.session_id=? AND c.sequence>=? AND c.sequence<=? AND s.state='ready' AND s.started>=?
            ORDER BY c.sequence LIMIT 901
            """, [bounds.sessionID, bounds.firstSequence, bounds.lastSequence, Date().timeIntervalSince1970 - Double(settings.retentionDays) * 86400])
        guard rows.count <= 900 else { throw JournalReadError("CATALOG_CHANGED") }
        var names: [String: String] = [:]
        return try rows.map { row in
            guard let id = row["id"], let sequence = Int(row["sequence"] ?? ""), let ms = Int64(row["captured_ms"] ?? ""),
                  let display = UInt32(row["display_id"] ?? ""), let segment = row["segment_id"], let path = row["path"],
                  let index = Int(row["frame_index"] ?? ""), let started = Double(row["segment_started"] ?? "") else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            let privateFrame = row["privacy_placeholder"] == "1"
            let appID = privateFrame ? nil : row["application_id"]
            if let appID, names[appID] == nil {
                names[appID] = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appID).map {
                    FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "")
                } ?? "未知应用"
            }
            let capture = JournalCapture(id: id, sessionID: bounds.sessionID, sequence: sequence, capturedAtMs: ms,
                timezoneOffsetSeconds: Int(row["timezone_offset"] ?? "") ?? 0, displayID: display,
                frontmostApplication: privateFrame ? nil : JournalApplication(id: appID, name: appID.flatMap { names[$0] } ?? "未知应用"),
                privacyPlaceholder: privateFrame, availableUntilMs: Int64((started + Double(settings.retentionDays) * 86400) * 1000))
            return JournalIndexedCapture(capture: capture, segmentID: segment, frameIndex: index,
                width: Int(row["width"] ?? "") ?? 0, height: Int(row["height"] ?? "") ?? 0, path: path)
        }
    }
    static func intervals(for captures: [JournalCapture], events: [JournalInterval]) -> [JournalInterval] {
        guard let first = captures.first, let last = captures.last else { return [] }
        var result = events.filter { $0.endMs > first.capturedAtMs && $0.startMs < last.capturedAtMs }
        for (a, b) in zip(captures, captures.dropFirst()) {
            if a.privacyPlaceholder { result.append(JournalInterval(startMs: a.capturedAtMs, endMs: min(b.capturedAtMs, a.capturedAtMs + 60000), kind: "privacy")) }
            if b.capturedAtMs - a.capturedAtMs > 60000 { result.append(JournalInterval(startMs: a.capturedAtMs + 60000, endMs: b.capturedAtMs, kind: "unknown")) }
        }
        return result.sorted { $0.startMs < $1.startMs }
    }
}
