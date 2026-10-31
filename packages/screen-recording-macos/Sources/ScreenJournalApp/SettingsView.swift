import SwiftUI
import AppKit

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var recorder: CaptureCoordinator
    @State private var draft = RecordingSettings()
    @State private var excluded = ""
    @State private var error = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("设置").font(.title2.bold())
                Spacer()
                Text("ScreenJournal").foregroundStyle(.secondary)
            }.padding(20)
            Divider()
            Form {
                Section("采集") {
                    Picker("采样间隔", selection: $draft.interval) {
                        ForEach([1.0, 5, 10, 20, 30, 60], id: \.self) { Text("\(Int($0)) 秒").tag($0) }
                    }
                    Picker("图像高度", selection: $draft.height) {
                        Text("720").tag(720); Text("1080").tag(1080)
                    }
                }
                Section("存储") {
                    Stepper("保留 \(draft.retentionDays) 天", value: $draft.retentionDays, in: 1...30)
                    Stepper("容量上限 \(draft.maxGiB) GiB", value: $draft.maxGiB, in: 1...100)
                    LabeledContent("当前占用", value: ByteCountFormatter.string(fromByteCount: recorder.status.diskBytes, countStyle: .binary))
                    Text("达到期限或容量时，最早的整段记录会被删除。屏幕记录仅存储在此 Mac。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("隐私") {
                    HStack {
                        Text("排除应用")
                        Spacer()
                        Button("选择应用…", action: chooseApplication)
                    }
                    TextEditor(text: $excluded)
                        .font(.system(.body, design: .monospaced))
                        .frame(height: 90)
                        .accessibilityLabel("排除应用，每行一个 bundle ID")
                    Text("每行一个 bundle ID。前台排除应用仅保存占位；背景排除应用窗口不采集。应用内网页和系统通知不属于应用级排除保证。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("诊断信息") {
                    LabeledContent("状态", value: recorder.status.displayState)
                    if !recorder.readServiceError.isEmpty {
                        Text("远程查看不可用：\(recorder.readServiceError)").foregroundStyle(.orange)
                    }
                    if recorder.status.validation { Text("隔离验证模式（含显式注入参数）").foregroundStyle(.orange) }
                    if let time = recorder.status.lastSuccess {
                        Text("最近采样：\(Date(timeIntervalSince1970: time).formatted())")
                    }
                    Text("已采样 \(recorder.status.successfulSamples) / 应有 \(recorder.status.expectedTicks) · 占位 \(recorder.status.privacySamples) · 跳过 \(recorder.status.busySkipped) · 失败 \(recorder.status.failedSamples)")
                    Text("采样计数包含未封口的帧，最多每 10 分钟完成一次存储提交；异常退出可能损失当前未封口的记录。")
                    Text("\(recorder.status.state) · \(recorder.status.reason) · 代际 \(recorder.status.generation) · 在途 \(recorder.status.inFlight ? "是" : "否")")
                        .textSelection(.enabled)
                    Text(recorder.paths.root.path).textSelection(.enabled)
                }.font(.caption)
            }.formStyle(.grouped)
            Divider()
            HStack {
                Text(error).font(.caption).foregroundStyle(.red)
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存", action: save).keyboardShortcut(.defaultAction)
            }.padding(16)
        }
        .frame(width: 580, height: 620)
        .onAppear { draft = recorder.settings; excluded = draft.excludedApplications.joined(separator: "\n") }
    }
    private func save() {
        do {
            draft.excludedApplications = excluded.components(separatedBy: .newlines)
            let next = try draft.validated()
            let current = recorder.settings
            // Saving an unchanged form must not rotate recording segments or invalidate playback.
            if next.interval != current.interval || next.height != current.height || next.retentionDays != current.retentionDays
                || next.maxGiB != current.maxGiB || next.excludedApplications != current.excludedApplications {
                try recorder.apply(next)
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
    private func chooseApplication() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.applicationBundle]; panel.directoryURL = URL(fileURLWithPath: "/Applications")
        if panel.runModal() == .OK {
            let identifiers = panel.urls.compactMap { Bundle(url: $0)?.bundleIdentifier }
            excluded = ([excluded] + identifiers).filter { !$0.isEmpty }.joined(separator: "\n")
        }
    }
}
