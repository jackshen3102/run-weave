import Foundation
import CoreGraphics

actor StorageEngine {
    let paths: StorePaths
    private let lock: InstanceLock
    private let database: RecordStore
    private let frames: FrameStore
    let sessionID = UUID().uuidString
    init(paths: StorePaths) throws {
        self.paths = paths
        try paths.prepare()
        lock = try InstanceLock(paths: paths)
        database = try RecordStore(paths: paths)
        frames = FrameStore(database: database)
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
