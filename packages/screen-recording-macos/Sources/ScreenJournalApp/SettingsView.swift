import SwiftUI
import AppKit

struct SettingsView: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var recorder: CaptureCoordinator
    @State private var draft = RecordingSettings()
    @State private var excluded = ""
    @State private var error = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("ScreenJournal").font(.title.bold())
                Text("屏幕仅存储在此 Mac；关闭窗口后继续记录。")
                Text("状态：\(recorder.status.displayState)")
                if !recorder.readServiceError.isEmpty { Text("远程查看不可用：\(recorder.readServiceError)").foregroundStyle(.orange) }
                Button("查看记录…") { openWindow(id: "journal") }
                DisclosureGroup("诊断信息") {
                    Text("\(recorder.status.state) · \(recorder.status.reason) · 代际 \(recorder.status.generation) · 在途 \(recorder.status.inFlight ? "是" : "否")").font(.caption).textSelection(.enabled)
                }
                if recorder.status.validation { Text("隔离验证模式（含显式注入参数）").foregroundStyle(.orange) }
                if let time = recorder.status.lastSuccess { Text("最近采样：\(Date(timeIntervalSince1970: time).formatted())") }
                Text("已采样 \(recorder.status.successfulSamples) / 应有 \(recorder.status.expectedTicks) · 占位 \(recorder.status.privacySamples) · 跳过 \(recorder.status.busySkipped) · 失败 \(recorder.status.failedSamples)").font(.caption)
                Text("采样计数包含未封口的帧，最多每 10 分钟完成一次存储提交。").font(.caption).foregroundStyle(.secondary)
                Text("目录用量：\(ByteCountFormatter.string(fromByteCount: recorder.status.diskBytes, countStyle: .binary))")
                HStack {
                    Button("授权屏幕录制") { _ = CGRequestScreenCaptureAccess() }
                    Button("开始／恢复记录") { recorder.start() }.buttonStyle(.borderedProminent)
                    Button("暂停记录") { recorder.pause() }
                }
                Divider()
                Picker("采样间隔", selection: $draft.interval) { ForEach([1.0, 5, 10, 20, 30, 60], id: \.self) { Text("\(Int($0)) 秒").tag($0) } }
                Picker("图像高度", selection: $draft.height) { Text("720").tag(720); Text("1080").tag(1080) }
                Stepper("保留 \(draft.retentionDays) 天", value: $draft.retentionDays, in: 1...30)
                Stepper("容量上限 \(draft.maxGiB) GiB", value: $draft.maxGiB, in: 1...100)
                Text("达到期限或容量时，最早的整段记录会被删除；异常退出可能损失当前未封口的最多 10 分钟记录。").font(.caption).foregroundStyle(.secondary)
                HStack { Text("排除应用（每行一个 bundle ID）"); Spacer(); Button("选择应用…", action: chooseApplication) }
                TextEditor(text: $excluded).font(.system(.body, design: .monospaced)).frame(height: 110).border(Color.secondary.opacity(0.3))
                Text("前台排除应用仅保存占位；背景排除应用窗口不采集。应用内网页和系统通知不属于应用级排除保证。").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("保存配置") {
                        do { draft.excludedApplications = excluded.components(separatedBy: .newlines); try recorder.apply(draft); error = "配置已保存" }
                        catch { self.error = error.localizedDescription }
                    }
                    Text(error).font(.caption)
                }
                Text(recorder.paths.root.path).font(.caption).textSelection(.enabled)
            }.padding(24)
        }.onAppear { draft = recorder.settings; excluded = draft.excludedApplications.joined(separator: "\n") }
        .onChange(of: recorder.settings) { _, settings in draft = settings; excluded = settings.excludedApplications.joined(separator: "\n") }
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
