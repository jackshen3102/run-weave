import AppKit
import Combine

@MainActor final class RecorderModel: ObservableObject {
    @Published var coordinator: CaptureCoordinator?
    @Published var startupError = ""
    @Published var showingSettings = false
    @Published var exportingAppUsage = false
    let appUsage = AppUsageCollector()
    var reopenMainWindow: (() -> Void)?
    func exportAppUsage() {
        guard !exportingAppUsage else { return }
        let panel = NSOpenPanel()
        panel.title = "选择应用使用记录的导出位置"
        panel.prompt = "导出到此文件夹"
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false; panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let parent = panel.url else { return }
        let output = parent.appendingPathComponent("ScreenJournal-AppUsage-" + UUID().uuidString)
        exportingAppUsage = true
        Task {
            defer { exportingAppUsage = false }
            do {
                let report = try await Task.detached(priority: .utility) { try AppUsageExport().run(to: output) }.value
                let alert = NSAlert()
                let collected = report["state"] as? String == "snapshot_collected"
                let identified = (report["deviceIdentity"] as? [String: Any])?["state"] as? String == "available"
                alert.messageText = collected ? "应用使用记录已导出" : "应用使用记录未完整导出"
                alert.informativeText = "仅包含已同步到这台 Mac 的其他设备记录，可能存在延迟或缺失。\n设备信息：\(identified ? "已读取" : "未能读取")。\n\(output.path)"
                if !collected || !identified {
                    let identityError = (report["deviceIdentity"] as? [String: Any])?["error"] as? String
                    alert.informativeText += "\n" + ((report["error"] as? String) ?? identityError ?? "部分记录未能读取，请查看导出结果。")
                    alert.informativeText += "\n如提示权限不足，请在系统设置的完全磁盘访问权限中允许 ScreenJournal，然后重新导出。"
                }
                alert.addButton(withTitle: "打开导出文件夹"); alert.addButton(withTitle: "关闭")
                if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(output) }
            } catch {
                let alert = NSAlert(); alert.messageText = "导出失败"; alert.informativeText = error.localizedDescription; alert.runModal()
            }
        }
    }
    func start() async {
        do {
            umask(0o077)
            let args = Array(CommandLine.arguments.dropFirst())
            let validationFlags = args.filter { $0.hasPrefix("--validation-") }
            var directory: String?
            var maxBytes: Int64?
            var freeBytes: Int64?
            #if DEBUG
            for flag in validationFlags {
                guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { throw journalError("missing_validation_argument") }
                switch flag {
                case "--validation-data-dir": directory = args[index + 1]
                case "--validation-conversation-app":
                    guard args.contains("--validation-data-dir"),
                          Bundle(path: args[index + 1])?.bundleIdentifier?.hasPrefix("com.runweave.desktop.beta.") == true else {
                        throw journalError("validation_requires_beta_application_and_isolated_directory")
                    }
                case "--validation-max-bytes":
                    guard let value = Int64(args[index + 1]), value > 0 else { throw journalError("invalid_validation_max_bytes") }; maxBytes = value
                case "--validation-free-bytes":
                    guard let value = Int64(args[index + 1]), value >= 0 else { throw journalError("invalid_validation_free_bytes") }; freeBytes = value
                default: throw journalError("unknown_validation_argument")
                }
            }
            if directory == nil && (maxBytes != nil || freeBytes != nil) { throw journalError("validation_requires_isolated_directory") }
            #else
            guard validationFlags.isEmpty else { throw journalError("validation_arguments_disabled_in_release") }
            #endif
            let paths = try StorePaths(root: directory.map { URL(fileURLWithPath: $0) } ?? StorePaths.standard,
                validation: directory != nil, maxBytes: maxBytes, freeBytes: freeBytes)
            let recorder = CaptureCoordinator(paths: paths)
            await recorder.initialize()
            coordinator = recorder
            if !paths.validation && recorder.status.state != "failed" { appUsage.start() }
            if recorder.status.state == "failed" {
                fputs("ScreenJournal: \(recorder.status.reason)\n", stderr)
                if recorder.status.reason.hasPrefix("writer_active") {
                    let alert = NSAlert(); alert.messageText = "ScreenJournal 已在记录此目录"
                    alert.informativeText = "已有实例持有数据目录；本实例不会写入。"; alert.runModal()
                    NSApp.terminate(nil)
                }
            }
        } catch { startupError = error.localizedDescription }
    }
}
