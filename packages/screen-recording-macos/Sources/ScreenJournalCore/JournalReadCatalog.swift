import AppKit
import CryptoKit

struct JournalReadCatalog {
    static func load(_ db: RecordStore, settings: RecordingSettings, now: Int64 = journalNowMs(), zone: TimeZone = .current) throws -> JournalCatalog {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = zone; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        let cutoff = Double(now) / 1000 - Double(settings.retentionDays) * 86400
        let events = try db.rows("SELECT state,reason,started,ended FROM state_events WHERE ended>=? AND state!='sourceRetired' ORDER BY id", [cutoff])
        let breaks = events.filter { ["pausedSystem","stopped","gap","failed","blockedPermission","blockedStorage"].contains($0["state"] ?? "") }
            .flatMap { row in [row["started"],row["ended"]].compactMap { $0.flatMap(Double.init).map { Int64($0 * 1000) } } }.sorted()
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
        var blocks: [String: Int] = [:]
        var block = 0
        var days: [Int64: JournalDay] = [:]
        // Gaps are chronological facts across all sessions, including restarts.
        // Return only gap boundaries, never an unbounded array of capture rows.
        let samplingGaps = try db.rows("""
            WITH observed AS (
                SELECT c.captured_ms AS end_ms,
                       LAG(c.captured_ms) OVER (ORDER BY c.captured_ms,c.id) AS previous_ms
                FROM captures c JOIN segments s ON s.id=c.segment_id
                WHERE s.state='ready' AND s.started>=?
            )
            SELECT previous_ms+60000 AS start_ms,end_ms FROM observed WHERE end_ms-previous_ms>60000
            """, [cutoff]).compactMap { row -> JournalInterval? in
                guard let start = Int64(row["start_ms"] ?? ""), let end = Int64(row["end_ms"] ?? "") else { return nil }
                return JournalInterval(startMs: start, endMs: end, kind: "unknown")
            }
        var hash = SHA256()
        for sessionRow in sessions {
            block += 1
            guard let session = sessionRow["id"] else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            var after = Int.min
            var firstID: String?, firstSequence = 0, lastSequence = 0
            var startMs: Int64 = 0, endMs: Int64 = 0
            var display: UInt32 = 0, count = 0
            var previewID: String?, previousDay: Int64?, activityKind = "active", applicationID: String?
            func finish() {
                guard let id = firstID else { return }
                let key = "r-" + id
                blocks[key] = block
                members[key] = JournalRangeBounds(sessionID: session, firstSequence: firstSequence, lastSequence: lastSequence)
                ranges.append(JournalRange(rangeID: key, startMs: startMs, endMs: endMs, displayID: display,
                    sampleCount: count, previewCaptureID: previewID, state: "ready", activityKind: activityKind))
                firstID = nil; previewID = nil; count = 0
            }
            while true {
                let rows = try db.rows("""
                    SELECT c.*
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
                    guard let dayInterval = calendar.dateInterval(of: .day, for: date) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
                    let dayStart = Int64(dayInterval.start.timeIntervalSince1970 * 1000)
                    if days[dayStart] == nil {
                        days[dayStart] = JournalDay(day: formatter.string(from: date), startMs: dayStart, endMs: Int64(dayInterval.end.timeIntervalSince1970 * 1000))
                    }
                    let idle = (row["idle_seconds"].flatMap(Double.init) ?? 0) >= 120
                    let kind = row["privacy_placeholder"] == "1" ? "privacy" : !idle ? "active" :
                        row["visual_changed"] == nil ? "unknown" : row["visual_changed"] == "1" ? "passive" : "quiet"
                    let boundary = firstID != nil && (display != nextDisplay || ms < endMs || ms - endMs > 120000 ||
                        CaptureActivity.crossesBreak(breaks, after: endMs, through: ms) || dayStart != previousDay ||
                        (applicationID != row["application_id"] && (activityKind != "active" || kind != "active")))
                    if boundary || (firstID != nil && kind != activityKind) { finish() }
                    if boundary { block += 1 }
                    applicationID = row["application_id"]
                    if firstID == nil { firstID = id; firstSequence = sequence; startMs = ms; display = nextDisplay; activityKind = kind }
                    if previewID == nil && row["privacy_placeholder"] != "1" { previewID = id }
                    lastSequence = sequence; endMs = ms; count += 1; previousDay = dayStart
                    hash.update(data: Data("\(id):\(row["segment_id"] ?? ""):\(ms):\(kind)|".utf8))
                }
            }
            finish()
        }
        // A short visual interruption stays in its stable parent, with evidence
        // retained. Never smooth across an app/system/privacy/day boundary.
        var merged: [JournalRange] = []
        var i = 0
        while i < ranges.count {
            var range = ranges[i]
            while range.activityKind == "quiet", i + 2 < ranges.count {
                let change = ranges[i + 1], next = ranges[i + 2]
                guard change.activityKind == "passive", next.activityKind == "quiet",
                      next.startMs - change.startMs <= 30000,
                      blocks[range.rangeID] == blocks[change.rangeID], blocks[range.rangeID] == blocks[next.rangeID],
                      let first = members[range.rangeID], let last = members[next.rangeID] else { break }
                range = JournalRange(rangeID: range.rangeID, startMs: range.startMs, endMs: next.endMs,
                    displayID: range.displayID, sampleCount: range.sampleCount + change.sampleCount + next.sampleCount,
                    previewCaptureID: range.previewCaptureID, state: "ready", activityKind: "quiet",
                    transientChangeCount: (range.transientChangeCount ?? 0) + 1)
                members[range.rangeID] = JournalRangeBounds(sessionID: first.sessionID, firstSequence: first.firstSequence, lastSequence: last.lastSequence)
                members.removeValue(forKey: change.rangeID); members.removeValue(forKey: next.rangeID)
                i += 2
            }
            merged.append(range); i += 1
        }
        ranges = merged
        ranges.sort { $0.startMs == $1.startMs ? $0.rangeID < $1.rangeID : $0.startMs < $1.startMs }
        let knownIntervals = events.compactMap { row -> JournalInterval? in
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
        // Preserve uncovered portions of a sampling gap even when another part
        // is explained by a system/error event (e.g. a failure detected later).
        let covered = knownIntervals.sorted { $0.startMs < $1.startMs }
        var intervals = knownIntervals
        var after = 0
        for gap in samplingGaps.sorted(by: { $0.startMs < $1.startMs }) {
            while after < covered.count && covered[after].endMs <= gap.startMs { after += 1 }
            var cursor = gap.startMs, index = after
            while index < covered.count && covered[index].startMs < gap.endMs {
                let event = covered[index]
                if event.startMs > cursor { intervals.append(JournalInterval(startMs: cursor, endMs: min(event.startMs, gap.endMs), kind: "unknown")) }
                cursor = max(cursor, event.endMs)
                if cursor >= gap.endMs { break }
                index += 1
            }
            if cursor < gap.endMs { intervals.append(JournalInterval(startMs: cursor, endMs: gap.endMs, kind: "unknown")) }
        }
        intervals.sort { $0.startMs < $1.startMs }
        // Hash the complete membership and availability semantics, not just a row count.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        hash.update(data: Data((String(settings.retentionDays) + zone.identifier).utf8))
        hash.update(data: try encoder.encode(intervals))
        let revision = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return JournalCatalog(revision: revision, deviceID: try db.scalar("SELECT id FROM device LIMIT 1") ?? "unknown",
            days: days.values.sorted { $0.startMs > $1.startMs }, ranges: ranges, members: members, intervals: intervals,
            hasPending: (Int(try db.scalar("SELECT COUNT(*) FROM segments WHERE state='writing'") ?? "0") ?? 0) > 0)
    }
    static func frames(_ bounds: JournalRangeBounds, database db: RecordStore, settings: RecordingSettings, offset: Int = 0) throws -> [JournalIndexedCapture] {
        let rows = try db.rows("""
            SELECT c.*,s.width,s.height,s.path,s.started AS segment_started FROM captures c JOIN segments s ON s.id=c.segment_id
            WHERE c.session_id=? AND c.sequence>=? AND c.sequence<=? AND s.state='ready' AND s.started>=?
            ORDER BY c.sequence LIMIT 900 OFFSET ?
            """, [bounds.sessionID, bounds.firstSequence, bounds.lastSequence, Date().timeIntervalSince1970 - Double(settings.retentionDays) * 86400, offset])
        return try indexed(rows, settings: settings)
    }
    static func indexed(_ rows: [[String: String]], settings: RecordingSettings) throws -> [JournalIndexedCapture] {
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
            var capture = JournalCapture(id: id, sessionID: row["session_id"] ?? "", sequence: sequence, capturedAtMs: ms,
                timezoneOffsetSeconds: Int(row["timezone_offset"] ?? "") ?? 0, displayID: display,
                frontmostApplication: privateFrame ? nil : JournalApplication(id: appID, name: appID.flatMap { names[$0] } ?? "未知应用"),
                privacyPlaceholder: privateFrame, availableUntilMs: Int64((started + Double(settings.retentionDays) * 86400) * 1000))
            capture.idleSeconds = row["idle_seconds"].flatMap(Double.init)
            capture.visualChanged = row["visual_changed"].map { $0 == "1" }
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
