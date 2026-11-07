import Foundation
import SQLite3

/// An explicit, read-only export of remote App.InFocus records. This is independent
/// of the recording writer and never changes Apple's stores or the recording store.
struct AppUsageExport {
    let home: URL
    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) { self.home = home }

    func run(to destination: URL) throws -> [String: Any] {
        let fm = FileManager.default
        let paths = try StorePaths(root: destination)
        let recordingRoot = StorePaths.standard.standardizedFileURL.path
        guard paths.root.path != recordingRoot, !paths.root.path.hasPrefix(recordingRoot + "/") else {
            throw journalError("请选择屏幕记录数据目录之外的导出位置")
        }
        // A new directory makes concurrent exports independent and never overwrites a prior export.
        try fm.createDirectory(at: paths.root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let source = home.appendingPathComponent("Library/Biome/streams/restricted/App.InFocus/remote")
        var report: [String: Any] = ["schemaVersion": 1, "createdAt": ISO8601DateFormatter().string(from: Date()),
            "source": source.path, "output": paths.root.path, "sourceModified": false, "networkUsed": false,
            "scope": "remote_only", "completeness": "unverified"]
        var entries: [[String: Any]] = []
        var bytes = 0
        do {
            let devices = try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            report["deviceDirectories"] = devices.map(\.lastPathComponent).sorted()
            for device in devices.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                let info = try device.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard info.isDirectory == true, info.isSymbolicLink != true else { continue }
                let target = try paths.file(device.lastPathComponent)
                try fm.createDirectory(at: target, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                for file in try fm.contentsOfDirectory(at: device, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                    let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                    guard info.isRegularFile == true, info.isSymbolicLink != true, file.lastPathComponent.allSatisfy({ $0.isASCII && $0.isNumber }) else { continue }
                    var entry: [String: Any] = ["device": device.lastPathComponent, "file": file.lastPathComponent]
                    do {
                        guard bytes + (info.fileSize ?? 0) <= 128 * 1024 * 1024 else { throw journalError("export_size_limit") }
                        let data = try Data(contentsOf: file)
                        guard bytes + data.count <= 128 * 1024 * 1024 else { throw journalError("export_size_limit") }
                        let output = try paths.file(device.lastPathComponent + "/" + file.lastPathComponent)
                        try data.write(to: output, options: .atomic)
                        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
                        bytes += data.count; entry["state"] = "copied"; entry["bytes"] = data.count
                    } catch { entry["state"] = "read_failed"; entry["error"] = error.localizedDescription }
                    entries.append(entry)
                }
            }
            report["state"] = entries.isEmpty ? "no_remote_files" : entries.contains { $0["state"] as? String != "copied" } ? "partial" : "snapshot_collected"
        } catch {
            report["state"] = "blocked"; report["error"] = error.localizedDescription
        }
        report["files"] = entries; report["copiedBytes"] = bytes
        report["deviceIdentity"] = deviceIdentity()
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        let manifest = try paths.file("manifest.json")
        try data.write(to: manifest, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
        return report
    }

    private func deviceIdentity() -> [String: Any] {
        var peers = identityRows("Library/Biome/sync/sync.db",
            query: "SELECT device_identifier, ids_device_identifier, name, platform FROM DevicePeer LIMIT 100",
            columns: ["device_identifier", "ids_device_identifier", "name", "platform"])
        let hardware = identityRows("Library/Application Support/Knowledge/knowledgeC.db",
            query: "SELECT ZRAPPORTID, ZMODEL FROM ZSYNCPEER WHERE ZRAPPORTID IS NOT NULL AND ZMODEL IS NOT NULL LIMIT 100",
            columns: ["ids_device_identifier", "hardware_model"])
        let rows = hardware["devices"] as? [[String: String]] ?? []
        var devices = peers["devices"] as? [[String: String]] ?? []
        for index in devices.indices {
            guard let id = devices[index]["ids_device_identifier"], !id.isEmpty else { continue }
            let models = Set(rows.filter { $0["ids_device_identifier"]?.uppercased() == id.uppercased() }
                .compactMap { $0["hardware_model"] }.filter { !$0.isEmpty })
            if models.count == 1, let model = models.first {
                devices[index]["hardware_model"] = model
                devices[index]["device_kind"] = model.hasPrefix("iPhone") ? "iphone" : model.hasPrefix("iPad") ? "ipad" : "unknown"
            }
            devices[index]["hardware_model_status"] = models.count == 1 ? "matched_ids_identifier" : models.isEmpty ? "unavailable" : "ambiguous"
        }
        peers["devices"] = devices
        peers["hardwareModelsState"] = hardware["state"]
        peers["hardwareModelsError"] = hardware["error"]
        return peers
    }

    private func identityRows(_ relativePath: String, query: String, columns: [String]) -> [String: Any] {
        let file = home.appendingPathComponent(relativePath)
        var db: OpaquePointer?
        // Immutable read avoids creating WAL/SHM sidecars in Apple's directory.
        // Device metadata may lag until the system checkpoints its database.
        let uri = file.absoluteString + "?mode=ro&immutable=1"
        guard sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
            let error = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open_failed"
            sqlite3_close(db); return ["state": "unavailable", "error": error]
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 2000)
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else {
            return ["state": "unavailable", "error": String(cString: sqlite3_errmsg(db))]
        }
        defer { sqlite3_finalize(statement) }
        var devices: [[String: String]] = []
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW {
            var row: [String: String] = [:]
            for (i, key) in columns.enumerated() {
                if let value = sqlite3_column_text(statement, Int32(i)) { row[key] = String(cString: value) }
            }
            devices.append(row); status = sqlite3_step(statement)
        }
        return ["state": status == SQLITE_DONE ? "available" : "partial", "devices": devices, "readMode": "immutable_checkpoint"]
    }

    /// Launch through `open -n -W ScreenJournal.app --args --export-app-usage ABSOLUTE_NEW_DIRECTORY`.
    /// Exits before recording initialization; an existing recording instance is left running.
    static func runCommandIfRequested() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.contains("--export-app-usage") else { return }
        do {
            guard args.count == 2, args[0] == "--export-app-usage", args[1].hasPrefix("/") else {
                throw journalError("usage: --export-app-usage ABSOLUTE_NEW_DIRECTORY")
            }
            let report = try AppUsageExport().run(to: URL(fileURLWithPath: args[1]).standardizedFileURL)
            print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8) ?? "")
            exit(report["state"] as? String == "snapshot_collected" ? 0 : 1)
        } catch { fputs("ScreenJournal app usage export: \(error.localizedDescription)\n", stderr); exit(1) }
    }
}
