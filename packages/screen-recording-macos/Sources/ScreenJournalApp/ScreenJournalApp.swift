import SwiftUI
import AppKit

@main struct ScreenJournalApp: App {
    @NSApplicationDelegateAdaptor(JournalDelegate.self) private var delegate
    var body: some Scene {
        MenuBarExtra {
            JournalMenu(model: delegate.model)
        } label: {
            JournalIcon(model: delegate.model)
        }
        Window("屏幕记录", id: "journal") {
            JournalBrowserRoot(model: delegate.model)
        }.defaultLaunchBehavior(.presented)
        .commands { JournalCommands(model: delegate.model) }
    }
}
@MainActor final class JournalDelegate: NSObject, NSApplicationDelegate {
    let model = RecorderModel()
    private var terminationSignal: DispatchSourceSignal?
    private var terminating = false
    private var didSaveForExit = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }; source.resume(); terminationSignal = source
        Task { await model.start() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        sender.setActivationPolicy(.accessory); return false
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        model.reopenMainWindow?()
        return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if didSaveForExit { return .terminateNow }
        guard !terminating else { return .terminateCancel }
        terminating = true
        Task {
            let success = await model.coordinator?.shutdown() ?? true
            if !success {
                let alert = NSAlert(); alert.messageText = "记录尚未完成保存"
                alert.informativeText = model.coordinator?.status.reason ?? "未知错误"
                alert.runModal()
            }
            terminating = false
            if success { didSaveForExit = true; sender.terminate(nil) }
        }
        // Keep the main dispatch queue available while the async writer finishes.
        return .terminateCancel
    }
}
private struct JournalIcon: View {
    @ObservedObject var model: RecorderModel
    var body: some View {
        if let recorder = model.coordinator { RecorderIcon(recorder: recorder) }
        else { Image(systemName: "record.circle") }
    }
}
private struct RecorderIcon: View {
    @ObservedObject var recorder: CaptureCoordinator
    var body: some View {
        Image(systemName: recorder.status.state == "recording" ? "record.circle.fill" : recorder.status.state == "stopped" ? "pause.circle" : "exclamationmark.circle")
            .accessibilityLabel("ScreenJournal \(recorder.status.state)")
    }
}
private struct JournalMenu: View {
    @ObservedObject var model: RecorderModel
    @Environment(\.openWindow) var openWindow
    var body: some View {
        if let recorder = model.coordinator { RecorderMenu(recorder: recorder) }
        Button("打开 ScreenJournal") { showJournal(openWindow, model: model) }
        Button("设置…") { showJournal(openWindow, model: model, settings: true) }
            .disabled(model.coordinator == nil)
        Divider()
        Button("退出 ScreenJournal") { NSApp.terminate(nil) }
    }
}
private struct RecorderMenu: View {
    @ObservedObject var recorder: CaptureCoordinator
    var body: some View {
        Text(recorder.status.displayState)
        Button("开始／恢复记录") { recorder.start() }.disabled(recorder.status.desiredRecording && recorder.status.state == "recording")
        Button("暂停记录") { recorder.pause() }.disabled(!recorder.status.desiredRecording)
    }
}

private struct JournalCommands: Commands {
    @ObservedObject var model: RecorderModel
    @Environment(\.openWindow) private var openWindow
    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("设置…") { showJournal(openWindow, model: model, settings: true) }
                .keyboardShortcut(",", modifiers: .command)
                .disabled(model.coordinator == nil)
        }
    }
}

@MainActor private func showJournal(_ openWindow: OpenWindowAction, model: RecorderModel, settings: Bool = false) {
    NSApp.setActivationPolicy(.regular)
    openWindow(id: "journal")
    model.showingSettings = settings
    NSApp.activate(ignoringOtherApps: true)
}

private struct JournalSettingsPresentedKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var journalSettingsPresented: Bool {
        get { self[JournalSettingsPresentedKey.self] }
        set { self[JournalSettingsPresentedKey.self] = newValue }
    }
}

private struct JournalBrowserRoot: View {
    @ObservedObject var model: RecorderModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Group {
            if let recorder = model.coordinator {
                JournalBrowserView(recorder: recorder) { model.showingSettings = true }
            } else { Text(model.startupError.isEmpty ? "正在检查记录…" : model.startupError).padding() }
        }
        .environment(\.journalSettingsPresented, model.showingSettings)
        .sheet(isPresented: $model.showingSettings) {
            if let recorder = model.coordinator { SettingsView(recorder: recorder) }
        }
        .onAppear {
            model.reopenMainWindow = { [weak model] in
                guard let model else { return }
                showJournal(openWindow, model: model)
            }
        }
    }
}
