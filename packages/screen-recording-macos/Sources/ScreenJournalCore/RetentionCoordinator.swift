import Foundation

struct RetentionCoordinator {
    static func remove(_ db: RecordStore, segment: SegmentRecord) throws {
        guard segment.state != "writing" else { throw journalError("cannot_delete_active_writer") }
        // Keep only opaque capture identities/times for the analysis retention window.
        // Persist before removing media, including when the analyzer has never run.
        if segment.state != "deleting" {
            let captures = try db.rows("SELECT id,captured_ms FROM captures WHERE segment_id=? ORDER BY frame_index", [segment.id])
            let body = try analysisJSON(captures)
            try db.transaction {
                if !captures.isEmpty {
                    let times = captures.compactMap { Double($0["captured_ms"] ?? "").map { $0/1000 } }
                    try db.execute("INSERT INTO state_events(started,ended,state,reason,affected) VALUES (?,?,'sourceRetired',?,?)", [times.min() ?? segment.start,times.max() ?? segment.end,body,captures.count])
                }
                try db.execute("UPDATE segments SET state='deleting' WHERE id=?", [segment.id])
            }
        }
        guard db.reads.invalidate(segment.id) else {
            try db.event("warning", "read_cleanup_pending")
            return
        }
        for relative in ["media/\(segment.id).mp4", "pending/\(segment.id).mp4"] {
            let file = try db.paths.file(relative)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        try db.transaction { try db.execute("DELETE FROM segments WHERE id=?", [segment.id]) }
        db.reads.removed(segment.id)
    }
    static func enforce(_ db: RecordStore, settings: RecordingSettings, now: Date = Date()) throws -> Int64 {
        let cutoff = now.timeIntervalSince1970 - Double(settings.retentionDays) * 86400
        for segment in try db.segments() where segment.state != "writing" && (segment.start < cutoff || segment.state == "deleting") {
            try remove(db, segment: segment)
        }
        try db.execute("DELETE FROM state_events WHERE state!='sourceRetired' AND ended < ?", [cutoff])
        try db.execute("DELETE FROM state_events WHERE state='sourceRetired' AND ended < ?", [now.timeIntervalSince1970-30*86400])
        try db.execute("DELETE FROM sessions WHERE ended IS NOT NULL AND id NOT IN (SELECT session_id FROM captures)")
        try db.checkpoint()
        let limit = db.paths.maxBytesOverride ?? Int64(settings.maxGiB) * gib
        for segment in try db.segments() where segment.state == "ready" || segment.state == "unavailable" {
            if try db.paths.usage() <= limit { break }
            try remove(db, segment: segment)
            // Deletion creates WAL pages. Reclaim those temporary bytes before
            // deciding whether another retained segment must be removed.
            try db.checkpoint()
        }
        try db.checkpoint()
        return try db.paths.usage()
    }
}
