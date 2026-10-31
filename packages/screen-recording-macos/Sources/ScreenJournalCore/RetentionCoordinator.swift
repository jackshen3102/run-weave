import Foundation

struct RetentionCoordinator {
    static func remove(_ db: RecordStore, segment: SegmentRecord) throws {
        guard segment.state != "writing" else { throw journalError("cannot_delete_active_writer") }
        try db.execute("UPDATE segments SET state='deleting' WHERE id=?", [segment.id])
        for relative in ["media/\(segment.id).mp4", "pending/\(segment.id).mp4"] {
            let file = try db.paths.file(relative)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        try db.transaction { try db.execute("DELETE FROM segments WHERE id=?", [segment.id]) }
    }
    static func enforce(_ db: RecordStore, settings: RecordingSettings, now: Date = Date()) throws -> Int64 {
        let cutoff = now.timeIntervalSince1970 - Double(settings.retentionDays) * 86400
        for segment in try db.segments() where segment.state != "writing" && (segment.start < cutoff || segment.state == "deleting") {
            try remove(db, segment: segment)
        }
        try db.execute("DELETE FROM state_events WHERE ended < ?", [cutoff])
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
