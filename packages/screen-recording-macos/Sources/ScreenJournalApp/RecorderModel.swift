import AppKit
import Combine

@MainActor final class RecorderModel: ObservableObject {
    @Published var coordinator: CaptureCoordinator?
    @Published var startupError = ""
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
            coordinator = recorder
            await recorder.initialize()
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
