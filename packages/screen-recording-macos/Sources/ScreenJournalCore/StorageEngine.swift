import Foundation
import CoreGraphics
import CryptoKit

actor StorageEngine {
    let paths: StorePaths
    private let lock: InstanceLock
    private let database: RecordStore
    private let frames: FrameStore
    private var catalogCache: (key: String, value: JournalCatalog)?
    let sessionID = UUID().uuidString
    init(paths: StorePaths) throws {
        self.paths = paths
        try paths.prepare()
        lock = try InstanceLock(paths: paths)
        database = try RecordStore(paths: paths)
        frames = FrameStore(database: database)
    }
    func catalog(settings: RecordingSettings) throws -> JournalCatalog {
        let cutoff = Date().timeIntervalSince1970 - Double(settings.retentionDays) * 86400
        let segments = try database.rows("SELECT id,frames,started,ended FROM segments WHERE state='ready' AND started>=? ORDER BY id", [cutoff])
        let events = try database.rows("SELECT id,state,started,ended FROM state_events WHERE ended>=? AND ended>started AND state IN ('pausedSystem','stopped','gap','failed','blockedPermission','blockedStorage') ORDER BY id", [cutoff])
        let identity: [String: Any] = ["segments": segments, "events": events, "hasPending": try database.scalar("SELECT EXISTS(SELECT 1 FROM segments WHERE state='writing')") ?? "0", "retentionDays": settings.retentionDays, "timeZone": TimeZone.current.identifier]
        let key = SHA256.hash(data: try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys])).map { String(format: "%02x", $0) }.joined()
        if let cache = catalogCache, cache.key == key { return cache.value }
        let value = try JournalReadCatalog.load(database, settings: settings)
        catalogCache = (key, value)
        return value
    }
    func rangeFrames(_ bounds: JournalRangeBounds, settings: RecordingSettings) throws -> [JournalIndexedCapture] {
        try JournalReadCatalog.frames(bounds, database: database, settings: settings)
    }
    func permit(_ frame: JournalIndexedCapture, settings: RecordingSettings) throws -> JournalFramePermit {
        guard frame.capture.availableUntilMs > journalNowMs() else { throw JournalReadError("FRAME_GONE") }
        guard let row = try database.rows("SELECT state,started,path FROM segments WHERE id=?", [frame.segmentID]).first,
              row["state"] != "deleting" else { throw JournalReadError("FRAME_GONE") }
        guard row["state"] == "ready" else { throw JournalReadError("MEDIA_UNAVAILABLE") }
        guard let started = Double(row["started"] ?? ""), started + Double(settings.retentionDays) * 86400 > Date().timeIntervalSince1970 else { throw JournalReadError("FRAME_GONE") }
        let url = try paths.file(frame.path)
        guard FileManager.default.fileExists(atPath: url.path) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
        var gate: URL?
        #if DEBUG
        if paths.validation { gate = try paths.file("runtime/hold-read") }
        #endif
        return JournalFramePermit(frame: frame, url: url, lease: try database.reads.acquire(frame.segmentID), validationGate: gate)
    }
    func release(_ permit: JournalFramePermit) {
        database.reads.release(permit.lease)
        guard database.reads.activeCount(for: permit.frame.segmentID) == 0 else { return }
        do {
            guard try database.rows("SELECT state FROM segments WHERE id=?", [permit.frame.segmentID]).first?["state"] == "deleting" else { return }
            if let segment = try database.segments().first(where: { $0.id == permit.frame.segmentID && $0.state == "deleting" }) {
                try RetentionCoordinator.remove(database, segment: segment)
                try database.checkpoint()
            }
        } catch { try? database.event("warning", "read_cleanup_pending") }
    }
    func readChanges() -> AsyncStream<Int> { database.reads.changes() }
    func activeReadCount() -> Int { database.reads.activeCount }
    func readRevision() -> Int { database.reads.invalidationRevision }
    func stopReads() async {
        database.reads.cancelAll()
        while database.reads.activeCount > 0 { try? await Task.sleep(for: .milliseconds(20)) }
    }
    func prepare(settings: RecordingSettings) async throws -> Int64 {
        try await RecoveryCoordinator.reconcile(database)
        let bytes = try RetentionCoordinator.enforce(database, settings: settings)
        try database.execute("INSERT INTO sessions(id,started) VALUES (?,?)", [sessionID, Date().timeIntervalSince1970])
        return bytes
    }
    func prepareAppend(_ frame: CapturedFrame) async throws { try await frames.prepareAppend(frame.image, displayID: frame.displayID) }
    func append(_ frame: CapturedFrame, sequence: Int, permit: CapturePermit, generation: Int) throws -> Bool {
        let metadata = CaptureMetadata(id: UUID().uuidString, sessionID: sessionID, sequence: sequence,
            capturedAt: frame.capturedAt, timezoneOffset: TimeZone.current.secondsFromGMT(for: frame.capturedAt),
            displayID: frame.displayID, applicationID: frame.placeholder ? nil : frame.applicationID,
            idleSeconds: frame.idleSeconds, privacyPlaceholder: frame.placeholder)
        return try permit.withCurrent(generation) { try frames.append(frame.image, metadata: metadata) != nil }
    }
    func finalize() async throws { try await frames.finalize() }
    func needsRotation() -> Bool { frames.needsRotation }
    func maintain(settings: RecordingSettings) async throws -> Int64 {
        let budget = paths.maxBytesOverride ?? Int64(settings.maxGiB) * gib
        var bytes = try RetentionCoordinator.enforce(database, settings: settings)
        if bytes > budget {
            try await frames.finalize()
            bytes = try RetentionCoordinator.enforce(database, settings: settings)
        }
        guard bytes <= budget else { throw journalError("storage_quota_exceeded") }
        guard try paths.freeBytes() >= gib else { throw journalError("storage_free_space_below_1GiB") }
        return bytes
    }
    func event(_ state: String, _ reason: String, affected: Int = 0, at: Date = Date()) throws { try database.event(state, reason, affected: affected, at: at) }
    func shutdown(settings: RecordingSettings) async throws -> Int64 {
        try await frames.finalize()
        try database.execute("UPDATE sessions SET ended=?,clean=1 WHERE id=?", [Date().timeIntervalSince1970, sessionID])
        // The final segment is now eligible for the same retention and quota
        // rules as a segment finalized during recording.
        return try RetentionCoordinator.enforce(database, settings: settings)
    }
}
