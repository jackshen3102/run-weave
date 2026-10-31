import Foundation
import Darwin

func argument(_ name: String, in args: [String]) throws -> String {
    guard let index = args.firstIndex(of: name), args.indices.contains(index + 1), !args[index + 1].hasPrefix("--") else { throw journalError("missing_argument: \(name)") }
    return args[index + 1]
}
func printJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
struct ReportedInspectionFailure: Error {}
func inspect() async throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first, ["status", "verify", "extract"].contains(command) else { throw journalError("usage: ScreenJournalInspect status|verify|extract --data-dir PATH [--json] [--capture-id ID --output NEW_FILE]") }
    let paths = try StorePaths(root: URL(fileURLWithPath: argument("--data-dir", in: args)))
    let lock: InstanceLock?
    if command == "status" {
        do { lock = try InstanceLock(paths: paths, readOnly: true) }
        catch { if error.localizedDescription.hasPrefix("writer_active") { lock = nil } else { throw error } }
    }
    else { lock = try InstanceLock(paths: paths, readOnly: true) }
    defer { withExtendedLifetime(lock) {} }
    let db = try RecordStore(paths: paths, readOnly: true)
    if command == "status" {
        let snapshot = (try? JSONSerialization.jsonObject(with: Data(contentsOf: paths.file("runtime/status.json")))) as? [String: Any] ?? [:]
        let updated = snapshot["updatedAt"] as? Double ?? 0
        let owner = Int32((try String(contentsOf: paths.file("writer.lock"), encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines))
        let pidMatches = owner != nil && owner == (snapshot["pid"] as? NSNumber)?.int32Value && kill(owner!, 0) == 0
        let fresh = Date().timeIntervalSince1970 - updated < 15 && updated <= Date().timeIntervalSince1970 + 1
        try printJSON(["schema": try db.scalar("PRAGMA user_version") ?? "unknown", "runtime": snapshot,
            "writerLockHeld": lock == nil, "runtimeConfirmed": lock == nil && fresh && pidMatches, "diskBytes": try paths.usage(),
            "device": try db.rows("SELECT * FROM device"),
            "segments": try db.rows("SELECT state,COUNT(*) AS count FROM segments GROUP BY state"),
            "recentCaptures": try db.rows("SELECT id,captured_ms,segment_id,frame_index,privacy_placeholder FROM captures ORDER BY captured_ms DESC LIMIT 100"),
            "stateEvents": try db.rows("SELECT * FROM state_events ORDER BY id DESC LIMIT 50")])
        return
    }
    if command == "verify" {
        guard try db.scalar("PRAGMA integrity_check") == "ok", try db.rows("PRAGMA foreign_key_check").isEmpty else { throw journalError("sqlite_integrity_failed") }
        var count = 0
        var failures: [[String: String]] = []
        for segment in try db.segments() {
            do {
                guard segment.state == "ready" else { throw journalError("segment_\(segment.state)") }
                try RecoveryCoordinator.validateIndex(db, segment: segment)
                try await SegmentReader.verify(paths.file(segment.path), expected: segment.frames, width: segment.width, height: segment.height)
                count += segment.frames
            } catch { failures.append(["segmentID": segment.id, "error": error.localizedDescription]) }
        }
        try printJSON(["ok": failures.isEmpty, "decodedFrames": count, "failures": failures])
        if !failures.isEmpty { throw ReportedInspectionFailure() }; return
    }
    let id = try argument("--capture-id", in: args)
    guard let row = try db.rows("SELECT captures.*,segments.state,segments.path FROM captures JOIN segments ON segments.id=captures.segment_id WHERE captures.id=?", [id]).first else { throw journalError("capture_not_found") }
    guard row["state"] == "ready" else { throw journalError("capture_not_committed: \(row["state"] ?? "unknown")") }
    let settings = try JSONDecoder().decode(RecordingSettings.self, from: Data(contentsOf: paths.file("settings.json"))).validated()
    guard let timestamp = Double(row["captured_ms"] ?? ""), timestamp / 1000 >= Date().timeIntervalSince1970 - Double(settings.retentionDays) * 86400 else { throw journalError("capture_expired") }
    guard let relative = row["path"], let index = Int(row["frame_index"] ?? "") else { throw journalError("invalid_capture_index") }
    let output = URL(fileURLWithPath: try argument("--output", in: args)).standardizedFileURL
    guard !output.resolvingSymlinksInPath().path.hasPrefix(paths.root.path + "/") else { throw journalError("output_must_be_outside_store") }
    guard !FileManager.default.fileExists(atPath: output.path) else { throw journalError("output_already_exists") }
    let file = try paths.file(relative)
    guard FileManager.default.fileExists(atPath: file.path) else { throw journalError("media_missing") }
    let image = try await SegmentReader.image(file, index: index)
    try SegmentReader.png(image).write(to: output, options: .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
    try printJSON(["captureID": id, "output": output.path, "capturedMilliseconds": timestamp])
}
umask(0o077)
Task {
    do { try await inspect(); exit(0) }
    catch is ReportedInspectionFailure { exit(1) }
    catch { try? printJSON(["ok": false, "error": error.localizedDescription]); exit(1) }
}
dispatchMain()
