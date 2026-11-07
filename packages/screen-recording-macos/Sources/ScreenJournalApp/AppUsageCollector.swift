import AppKit
import Combine

struct AppUsageCollectionStatus: Codable {
    var phase = "disabled"
    var updatedAt = Date().timeIntervalSince1970
    var lastAttemptAt: Double?
    var lastSuccessAt: Double?
    var nextAttemptAt: Double?
    var newestEvent: String?
    var addedEvents: Int?
    var totalEvents: Int?
    var error: String?
}

/// One collector owned by the normal recording App instance; one-shot exports and
/// isolated validation instances never start this loop. No login item or daemon.
@MainActor final class AppUsageCollector: ObservableObject {
    @Published private(set) var enabled = UserDefaults.standard.bool(forKey: "appUsageAutomaticCollection")
    @Published private(set) var status = AppUsageCollectionStatus()
    @Published private(set) var collecting = false
    private var running = false
    private var loop: Task<Void, Never>?
    private var collection: Task<Void, Never>?
    private var process: Process?
    private let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ScreenJournalAppUsage")
    private let interval: UInt64 = 3600

    var label: String {
        if collecting { return "应用使用记录：正在归档" }
        if status.error != nil { return "应用使用记录：" + (status.error ?? "采集失败") }
        if let total = status.totalEvents { return "应用使用记录：已归档 \(total) 条事件" }
        return "应用使用记录：等待采集"
    }

    func start() {
        running = true
        if let paths = try? StorePaths(root: root), let file = try? paths.file("collection-status.json"),
           let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(AppUsageCollectionStatus.self, from: data) { status = saved }
        if enabled { startLoop() }
    }

    func setEnabled(_ value: Bool) {
        enabled = value
        UserDefaults.standard.set(value, forKey: "appUsageAutomaticCollection")
        if value { startLoop() }
        else {
            loop?.cancel(); loop = nil; collection?.cancel()
            if process?.isRunning == true { process?.terminate() }
            status.phase = collecting ? "stopping" : "disabled"; status.nextAttemptAt = nil; saveStatus()
        }
    }

    func collectNow() { guard running, enabled else { return }; _ = beginCollection() }

    func shutdown() async {
        running = false; loop?.cancel(); loop = nil; collection?.cancel()
        if process?.isRunning == true { process?.terminate() }
        if let collection { await collection.value }
        status.phase = enabled ? "app_stopped" : "disabled"; status.nextAttemptAt = nil; saveStatus()
    }

    private func startLoop() {
        guard running, enabled, loop == nil else { return }
        loop = Task { [weak self] in
            guard let self else { return }
            while self.running && self.enabled && !Task.isCancelled {
                let work = self.beginCollection()
                await work.value
                guard self.running, self.enabled, !Task.isCancelled else { return }
                if work.isCancelled { continue }
                self.status.nextAttemptAt = Date().timeIntervalSince1970 + Double(self.interval); self.saveStatus()
                do { try await Task.sleep(nanoseconds: self.interval * 1_000_000_000) } catch { return }
            }
        }
    }

    private func beginCollection() -> Task<Void, Never> {
        if let collection { return collection }
        collecting = true
        let work = Task { await performCollection() }
        collection = work
        return work
    }

    private func performCollection() async {
        defer { collecting = false; collection = nil }
        status.phase = "collecting"; status.lastAttemptAt = Date().timeIntervalSince1970
        status.error = nil; saveStatus()
        do {
            let paths = try StorePaths(root: root)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let pending = try paths.file("collection-pending")
            // Only this collector owns these scratch paths. Retain the last successful
            // copy until a newer import has committed; archive history is never deleted.
            if FileManager.default.fileExists(atPath: pending.path) { try FileManager.default.removeItem(at: pending) }
            let report = try await Task.detached(priority: .utility) { try AppUsageExport().run(to: pending) }.value
            try Task.checkCancellation()
            guard ["snapshot_collected", "partial"].contains(report["state"] as? String ?? "") else {
                throw journalError("未能读取同步记录，请检查完全磁盘访问权限和跨设备同步")
            }
            guard let tools = Bundle.main.resourceURL?.appendingPathComponent("AppUsageTools"),
                  FileManager.default.fileExists(atPath: tools.appendingPathComponent("archive.py").path) else {
                throw journalError("应用使用记录工具缺失，请更新 ScreenJournal")
            }
            let output = try paths.file("collection-pending/import-result.json")
            let errors = try paths.file("collection-pending/import-error.txt")
            var python: String?
            for candidate in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] where FileManager.default.isExecutableFile(atPath: candidate) {
                try Task.checkCancellation()
                if try await run(candidate, arguments: ["-E", "-s", "-B", "-c", "import sys; sys.exit(sys.version_info < (3,10))"], output: output, errors: errors) == 0 { python = candidate; break }
            }
            guard let python else { throw journalError("应用使用归档需要 Python 3.10 或更新版本") }
            let archive = try paths.file("archive.sqlite")
            let code = try await run(python, arguments: ["-E", "-s", "-B", tools.appendingPathComponent("archive.py").path,
                "--archive", archive.path, "import", pending.path], output: output, errors: errors)
            try Task.checkCancellation()
            guard code == 0 else { throw journalError("应用使用记录归档失败，详情见 collection-pending/import-error.txt") }
            guard let result = try JSONSerialization.jsonObject(with: Data(contentsOf: output)) as? [String: Any] else {
                throw journalError("应用使用记录归档结果无效")
            }
            status.addedEvents = result["added_events"] as? Int; status.totalEvents = result["total_events"] as? Int
            let diagnostics = result["diagnostics"] as? [String: Any]
            let devices = diagnostics?["devices"] as? [[String: Any]] ?? []
            status.newestEvent = devices.compactMap { $0["last"] as? String }.max()
            let latest = try paths.file("latest-export")
            if FileManager.default.fileExists(atPath: latest.path) { try FileManager.default.removeItem(at: latest) }
            try FileManager.default.moveItem(at: pending, to: latest)
            status.phase = report["state"] as? String == "partial" ? "partial" : "archived"
            status.lastSuccessAt = Date().timeIntervalSince1970
        } catch is CancellationError { status.phase = enabled ? "waiting" : "disabled" }
        catch { status.phase = "failed"; status.error = error.localizedDescription }
        saveStatus()
    }

    private func run(_ executable: String, arguments: [String], output: URL, errors: URL) async throws -> Int32 {
        try Task.checkCancellation()
        for file in [output, errors] {
            try Data().write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        let out = try FileHandle(forWritingTo: output), err = try FileHandle(forWritingTo: errors)
        defer { try? out.close(); try? err.close() }
        let child = Process(); child.executableURL = URL(fileURLWithPath: executable); child.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        for key in ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"] { environment.removeValue(forKey: key) }
        environment["PYTHONDONTWRITEBYTECODE"] = "1"; environment["PYTHONNOUSERSITE"] = "1"
        child.environment = environment; child.standardOutput = out; child.standardError = err
        child.standardInput = FileHandle.nullDevice; process = child
        // Bound a stuck interpreter/import; stderr goes to a private file, not a pipe
        // that could fill and deadlock. Stop/quit also terminates the active child.
        let timeout = Task {
            do {
                try await Task.sleep(nanoseconds: 120_000_000_000)
                if child.isRunning { child.terminate() }
                try await Task.sleep(nanoseconds: 1_000_000_000)
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            } catch { }
        }
        defer { timeout.cancel(); process = nil }
        return try await withCheckedThrowingContinuation { continuation in
            child.terminationHandler = { value in continuation.resume(returning: value.terminationStatus) }
            do { try child.run() }
            catch { child.terminationHandler = nil; continuation.resume(throwing: error) }
        }
    }

    private func saveStatus() {
        status.updatedAt = Date().timeIntervalSince1970
        do {
            let paths = try StorePaths(root: root)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try paths.write(status, to: "collection-status.json")
        } catch { status.error = "无法保存应用使用记录采集状态" }
    }
}
