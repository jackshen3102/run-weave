import Foundation
import CoreGraphics

// All operations are awaited by the coordinator's single worker. No concurrent writers.
final class FrameStore {
    let database: RecordStore
    private(set) var writer: SegmentWriter?
    private var accessibility: CaptureAXCheckpoint?
    private var activity = CaptureActivityDetector()
    init(database: RecordStore) { self.database = database }
    var needsRotation: Bool { guard let writer else { return false }; return writer.count >= 600 || writer.started.duration(to: .now) >= .seconds(600) }
    func prepareAppend(_ image: CGImage, displayID: UInt32) async throws {
        if let writer, needsRotation || writer.width != image.width || writer.height != image.height || writer.displayID != displayID { try await finalize() }
    }
    func append(_ image: CGImage, metadata: CaptureMetadata) throws -> String? {
        if let writer, needsRotation || writer.width != image.width || writer.height != image.height || writer.displayID != metadata.displayID {
            throw journalError("segment_rotation_required")
        }
        if writer == nil {
            let id = UUID().uuidString
            let path = "pending/\(id).mp4"
            try database.execute("INSERT INTO segments(id,path,state,started,ended,width,height,display_id) VALUES (?,?,'writing',?,?,?,?,?)",
                [id, path, metadata.capturedAt.timeIntervalSince1970, metadata.capturedAt.timeIntervalSince1970, image.width, image.height, metadata.displayID])
            writer = try SegmentWriter(id: id, url: database.paths.file(path), width: image.width, height: image.height, displayID: metadata.displayID)
        }
        guard let writer, let index = try writer.append(image) else { return nil }
        let visualChanged = activity.changed(image, metadata: metadata)
        var context = metadata.privacyPlaceholder ? nil : metadata.context
        var checkpoint: CaptureAXCheckpoint?
        if var value = context, let snapshot = metadata.accessibility {
            let identity = "\(metadata.sessionID):\(metadata.applicationID ?? ""):\(metadata.displayID):\(value.windowID):\(value.windowTitle ?? ""):\(value.url ?? "")"
            value.accessibility = CaptureAXCheckpoint.delta(snapshot, identity: identity, previous: accessibility)
            context = value
            checkpoint = CaptureAXCheckpoint(identity: identity, captureID: metadata.id, snapshot: snapshot)
        }
        try database.transaction {
            try database.execute("INSERT INTO captures VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [metadata.id, metadata.sessionID, metadata.sequence,
                writer.id, index, Int64(metadata.capturedAt.timeIntervalSince1970 * 1000), metadata.timezoneOffset, metadata.displayID,
                metadata.privacyPlaceholder ? nil : metadata.applicationID, metadata.idleSeconds, metadata.privacyPlaceholder ? 1 : 0, visualChanged.map { $0 ? 1 : 0 }])
            if let checkpoint {
                try CaptureAXStorage.save(checkpoint.snapshot, captureID: metadata.id, database: database)
            }
            if let context {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                let body = String(decoding: try encoder.encode(context), as: UTF8.self)
                try database.execute("INSERT INTO capture_context(capture_id,body) VALUES (?,?)", [metadata.id, body])
            }
            try database.execute("UPDATE segments SET frames=?, started=MIN(started,?), ended=MAX(ended,?) WHERE id=?", [index + 1, metadata.capturedAt.timeIntervalSince1970, metadata.capturedAt.timeIntervalSince1970, writer.id])
        }
        accessibility = checkpoint
        return metadata.id
    }
    func finalize() async throws {
        guard let current = writer else { return }
        // Keep ownership through finish, decode, fsync, rename and database commit.
        try await current.finish()
        if current.count == 0 {
            if FileManager.default.fileExists(atPath: current.url.path) { try FileManager.default.removeItem(at: current.url) }
            try database.execute("DELETE FROM segments WHERE id=?", [current.id]); writer = nil; return
        }
        guard let segment = try database.segments().first(where: { $0.id == current.id }) else { throw journalError("segment_index_missing") }
        try RecoveryCoordinator.validateIndex(database, segment: segment)
        guard segment.frames == current.count else { throw journalError("accepted_frame_index_mismatch") }
        try await SegmentReader.verify(current.url, expected: current.count, width: current.width, height: current.height)
        try RecoveryCoordinator.commit(database, id: current.id, source: current.url)
        writer = nil
    }
}
