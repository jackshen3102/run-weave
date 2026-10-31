import Foundation

struct RecoveryCoordinator {
    static func commit(_ db: RecordStore, id: String, source: URL) throws {
        let destination = try db.paths.file("media/\(id).mp4")
        try syncFile(source)
        if source != destination {
            guard !FileManager.default.fileExists(atPath: destination.path) else { throw journalError("commit_destination_exists") }
            try FileManager.default.moveItem(at: source, to: destination)
            try syncFile(destination.deletingLastPathComponent())
            try syncFile(source.deletingLastPathComponent())
        }
        let bytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        try db.transaction { try db.execute("UPDATE segments SET state='ready',path=?,bytes=?,failure=NULL WHERE id=?", ["media/\(id).mp4", bytes, id]) }
    }
    static func reconcile(_ db: RecordStore) async throws {
        for segment in try db.segments() {
            switch segment.state {
            case "deleting": try RetentionCoordinator.remove(db, segment: segment)
            case "writing":
                let media = try db.paths.file("media/\(segment.id).mp4")
                let pending = try db.paths.file("pending/\(segment.id).mp4")
                let candidate = FileManager.default.fileExists(atPath: media.path) ? media : pending
                do {
                    try validateIndex(db, segment: segment)
                    try await SegmentReader.verify(candidate, expected: segment.frames, width: segment.width, height: segment.height)
                    try commit(db, id: segment.id, source: candidate)
                } catch {
                    try db.execute("UPDATE segments SET state='unavailable',failure=? WHERE id=?", ["interrupted_segment_unrecoverable", segment.id])
                    try db.event("gap", "interrupted_segment_unrecoverable", affected: segment.frames, at: Date(timeIntervalSince1970: segment.start))
                    try db.execute("UPDATE state_events SET ended=? WHERE id=(SELECT MAX(id) FROM state_events WHERE state!='sourceRetired')", [segment.end])
                    for file in [media, pending] where FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                }
            case "ready":
                let file = try db.paths.file(segment.path)
                if !FileManager.default.fileExists(atPath: file.path) {
                    try db.execute("UPDATE segments SET state='unavailable',failure='committed_media_missing' WHERE id=?", [segment.id])
                    try db.event("gap", "committed_media_missing", affected: segment.frames)
                }
            default: break
            }
        }
        // Unknown files have no proven record ownership: report and account for them, never import or delete them.
        let known = Set(try db.segments().map(\.id))
        for folder in ["pending", "media"] {
            for file in try FileManager.default.contentsOfDirectory(at: db.paths.file(folder), includingPropertiesForKeys: nil) {
                let id = file.deletingPathExtension().lastPathComponent
                guard file.pathExtension == "mp4", UUID(uuidString: id) != nil, !known.contains(id) else { continue }
                _ = try db.paths.file("\(folder)/\(file.lastPathComponent)")
                try db.event("warning", "unowned_media_present")
            }
        }
        try db.execute("UPDATE sessions SET ended=? WHERE ended IS NULL", [Date().timeIntervalSince1970])
    }
    static func validateIndex(_ db: RecordStore, segment: SegmentRecord) throws {
        let row = try db.rows("SELECT COUNT(*) AS n,MIN(frame_index) AS lo,MAX(frame_index) AS hi FROM captures WHERE segment_id=?", [segment.id]).first ?? [:]
        guard Int(row["n"] ?? "") == segment.frames, Int(row["lo"] ?? "") == 0, Int(row["hi"] ?? "") == segment.frames - 1 else { throw journalError("capture_index_mismatch") }
    }
}
