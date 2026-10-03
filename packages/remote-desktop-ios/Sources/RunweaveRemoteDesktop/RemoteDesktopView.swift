import SwiftUI

/// The host owns navigation, privacy masking and presentation lifetime. This view
/// never starts a connection or changes the host's navigation state.
public struct RemoteDesktopView: View {
    @ObservedObject private var session: RemoteDesktopSession
    @State private var showsKeyboard = false
    @State private var text = ""
    @State private var modifiers: RemoteModifiers = []
    @State private var showsStatistics = false
    private let maskTextEntry: (AnyView) -> AnyView

    public init(session: RemoteDesktopSession, maskTextEntry: @escaping (AnyView) -> AnyView = { $0 }) {
        self.session = session; self.maskTextEntry = maskTextEntry
    }

    public var body: some View {
        VStack(spacing: 0) {
            if RemoteVideoRendererMode.legacyProbeEnabled {
                Text("模拟器负例验证 · Legacy 显示入口")
                    .font(.caption).foregroundColor(.orange).padding(6)
                    .accessibilityIdentifier("remote-desktop-legacy-probe")
            }
            HStack {
                Text(session.state.label).font(.caption).accessibilityIdentifier("remote-desktop-state")
                Spacer()
                Button {
                    showsStatistics.toggle()
                    if showsStatistics { showsKeyboard = false }
                } label: { Image(systemName: "waveform.path.ecg") }
                    .accessibilityLabel("连接统计")
                    .accessibilityIdentifier("remote-desktop-statistics-toggle")
                if session.state == .controllable {
                    Button {
                        showsKeyboard.toggle()
                        if showsKeyboard { showsStatistics = false }
                    } label: { Image(systemName: "keyboard") }
                        .accessibilityLabel("远程键盘")
                }
            }.padding(10)
            RemoteNativeSurface(session: session)
                .frame(minHeight: 100, maxHeight: .infinity)
                .layoutPriority(1)
                .background(Color.black)
                .accessibilityLabel("Mac 远程桌面")
                .accessibilityIdentifier("remote-desktop-video")
            HStack {
                Picker("输入模式", selection: $session.inputMode) {
                    ForEach(RemoteInputMode.allCases) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented)
                Button("右击") { session.click(button: 2) }
                    .disabled(session.state != .controllable)
                Button("复位缩放") { session.resetViewport() }
            }.padding(8)
            if showsKeyboard {
                keyboard
            }
            if showsStatistics {
                RemoteStatisticsView(statistics: session.statistics)
            }
        }
        .onChange(of: session.state) { state in
            if state != .controllable { modifiers = []; text = ""; showsKeyboard = false }
        }
        .onChange(of: showsKeyboard) { value in session.setTextEntryActive(value) }
        .onDisappear {
            modifiers = []; text = ""; showsKeyboard = false; showsStatistics = false
            session.setTextEntryActive(false)
        }
    }

    private var keyboard: some View {
        VStack(spacing: 8) {
            HStack {
                modifier("⌘", value: .command)
                modifier("⌃", value: .control)
                modifier("⌥", value: .option)
                modifier("⇧", value: .shift)
                Spacer()
                Text("修饰键作用于下一次快捷键").font(.caption2).foregroundColor(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach([RemoteKey.escape, .tab, .left, .up, .down, .right, .enter, .backspace], id: \.rawValue) { key in
                        Button(key.label) { session.sendKeyChord(code: key.rawValue, modifiers: modifiers); modifiers = [] }
                            .buttonStyle(.bordered)
                    }
                    ForEach(["A", "C", "V", "X", "Z"], id: \.self) { key in
                        Button(key) {
                            guard let code = RemoteHardwareKeyMap.asciiShortcut(key) else { return }
                            session.sendKeyChord(code: code, modifiers: modifiers)
                            modifiers = []
                        }.buttonStyle(.bordered)
                    }
                }
            }
            HStack {
                maskTextEntry(AnyView(TextField("输入中文、英文或 emoji", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .onSubmit(commitText)
                    .accessibilityIdentifier("remote-desktop-text")))
                Button("发送", action: commitText).disabled(text.isEmpty)
            }
            Text("文字按提交发送；快捷键使用上方按键。").font(.caption2).foregroundColor(.secondary)
        }.padding(10)
    }

    private func modifier(_ title: String, value: RemoteModifiers) -> some View {
        Button(title) {
            if modifiers.contains(value) { modifiers.remove(value) } else { modifiers.insert(value) }
        }.buttonStyle(.bordered).tint(modifiers.contains(value) ? .blue : .gray)
    }

    private func commitText() {
        guard !text.isEmpty else { return }
        session.sendText(text)
        text = ""
    }
}
