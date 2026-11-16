import Foundation

/// Text versions outlive individual video segments while referenced by captures.
enum CaptureAXStorage {
    static let schema = """
        CREATE TABLE ax_snapshots(hash TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE capture_ax(capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
            content_hash TEXT NOT NULL REFERENCES ax_snapshots(hash));
        CREATE INDEX capture_ax_content ON capture_ax(content_hash);
        CREATE TRIGGER capture_ax_cleanup AFTER DELETE ON capture_ax BEGIN
            DELETE FROM ax_snapshots WHERE hash=OLD.content_hash
                AND NOT EXISTS(SELECT 1 FROM capture_ax WHERE content_hash=ax_snapshots.hash);
        END;
        PRAGMA user_version=4;
        """
    static func save(_ next: CaptureAXSnapshot, captureID: String, database db: RecordStore) throws {
        func insert(_ snapshot: CaptureAXSnapshot) throws {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            try db.execute("INSERT OR IGNORE INTO ax_snapshots(hash,body) VALUES (?,?)",
                [snapshot.contentHash, String(decoding: try encoder.encode(snapshot), as: UTF8.self)])
        }
        try insert(next)
        try db.execute("INSERT INTO capture_ax(capture_id,content_hash) VALUES (?,?)",
            [captureID, next.contentHash])
    }
    static func snapshots(_ ids: [String], contexts: [String: CaptureWindowContext], database db: RecordStore) throws -> [String: CaptureAXSnapshot] {
        guard db.supportsAXSnapshots, !ids.isEmpty else { return [:] }
        let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
        let refs = try db.rows("SELECT capture_id,content_hash FROM capture_ax WHERE capture_id IN (\(placeholders))", ids)
        let hashes = Array(Set(refs.compactMap { $0["content_hash"] }))
        guard !hashes.isEmpty else { return [:] }
        let keys = Array(repeating: "?", count: hashes.count).joined(separator: ",")
        var versions: [String: CaptureAXSnapshot] = [:], result: [String: CaptureAXSnapshot] = [:]
        for row in try db.rows("SELECT hash,body FROM ax_snapshots WHERE hash IN (\(keys))", hashes) {
            if let hash = row["hash"], let body = row["body"],
               let value = try? JSONDecoder().decode(CaptureAXSnapshot.self, from: Data(body.utf8)), value.contentHash == hash { versions[hash] = value }
        }
        for row in refs {
            if let id = row["capture_id"], let hash = row["content_hash"], let value = versions[hash] { result[id] = CaptureAXSnapshot(texts: value.texts, truncated: contexts[id]?.accessibility?.truncated ?? value.truncated) }
        }
        return result
    }
    /// Every view/analysis batch starts with its own available baseline. No
    /// consumer must reopen an earlier/deleted video segment to understand text.
    static func rebase(_ captures: [JournalCapture], snapshots: [String: CaptureAXSnapshot]) -> [JournalCapture] {
        var seen: [String: String] = [:]
        return captures.map { original in
            var capture = original
            guard !capture.privacyPlaceholder, var context = capture.context, let delta = context.accessibility else { return capture }
            if delta.kind != "baseline", delta.baseCaptureID.flatMap({ seen[$0] }) != delta.baseHash,
               let snapshot = snapshots[capture.id], snapshot.contentHash == delta.contentHash {
                context.accessibility = CaptureAXDelta(kind: "baseline", baseCaptureID: nil, baseHash: nil,
                    contentHash: snapshot.contentHash, texts: snapshot.texts, removed: [], truncated: delta.truncated)
                capture.context = context
            }
            seen[capture.id] = delta.contentHash
            return capture
        }
    }
}
