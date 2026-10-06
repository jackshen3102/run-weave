import SwiftUI

/// The host owns navigation, privacy masking and presentation lifetime. This view
/// never starts a connection or changes the host's navigation state.
public struct RemoteDesktopView: View {
    @ObservedObject private var session: RemoteDesktopSession
    @State private var showsKeyboard = false
    @State private var showsShortcuts = false
    @State private var keyboardTop: CGFloat?
    @State private var text = ""
    @State private var modifiers: RemoteModifiers = []
    @State private var showsMenu = false
    @AppStorage("remoteDesktop.inputMode") private var preferredInputMode = RemoteInputMode.trackpad.rawValue
    @FocusState private var textEntryFocused: Bool
    private let hostName: String
    private let onClose: () -> Void
    private let maskTextEntry: (AnyView) -> AnyView

    public init(session: RemoteDesktopSession, hostName: String, onClose: @escaping () -> Void,
                maskTextEntry: @escaping (AnyView) -> AnyView = { $0 }) {
        self.session = session; self.hostName = hostName; self.onClose = onClose
        self.maskTextEntry = maskTextEntry
    }

    public var body: some View {
        ZStack(alignment: .bottom) {
            desktop
                // Keyboard presentation must not resize the video viewport or reset its zoom.
                .ignoresSafeArea(.keyboard, edges: .bottom)
            if showsKeyboard {
                keyboard
                    .background(.regularMaterial)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: RemoteKeyboardTop.self,
                                               value: geometry.frame(in: .global).minY)
                    })
                    .accessibilityIdentifier("remote-desktop-keyboard")
            }
        }
        .onPreferenceChange(RemoteKeyboardTop.self) { keyboardTop = $0 }
        .onAppear { session.inputMode = RemoteInputMode(rawValue: preferredInputMode) ?? .trackpad }
        .onChange(of: session.inputMode) { preferredInputMode = $0.rawValue }
        .onChange(of: session.state) { state in
            // A keyframe recovery temporarily suspends input, not the user's text draft.
            if state != .controllable && state != .waitingForFirstFrame && state != .recoveringVideo {
                modifiers = []; text = ""; showsKeyboard = false
            }
        }
        .onChange(of: showsKeyboard) { value in
            session.setTextEntryActive(value)
            if !value {
                textEntryFocused = false; showsShortcuts = false; modifiers = []; keyboardTop = nil
            }
        }
        .onDisappear {
            modifiers = []; text = ""; showsKeyboard = false; showsMenu = false
            textEntryFocused = false
            session.setTextEntryActive(false)
        }
    }

    private var desktop: some View {
        ZStack(alignment: .top) {
            RemoteNativeSurface(session: session, keyboardTop: showsKeyboard ? keyboardTop : nil,
                                suspendsInput: showsMenu)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .accessibilityLabel("Mac 远程桌面")
                .accessibilityIdentifier("remote-desktop-video")
                .accessibilityHidden(showsMenu)
            if !showsKeyboard {
                RemoteSessionControls(session: session, hostName: hostName, showsMenu: $showsMenu,
                                      openKeyboard: { showsMenu = false; showsKeyboard = true }, onClose: onClose)
            }
            VStack(spacing: 8) {
                if RemoteVideoRendererMode.legacyProbeEnabled {
                    Text("模拟器负例验证 · Legacy 显示入口")
                        .font(.caption).foregroundColor(.orange).padding(6)
                        .accessibilityIdentifier("remote-desktop-legacy-probe")
                }
                if session.state != .controllable {
                    Text(session.state.label)
                        .font(.caption).multilineTextAlignment(.center)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                        .padding(12)
                        .accessibilityIdentifier("remote-desktop-status")
                }
            }
            .allowsHitTesting(false)
        }
    }

    private var keyboard: some View {
        VStack(spacing: 8) {
            if showsShortcuts { shortcuts }
            HStack(spacing: 4) {
                Button {
                    showsShortcuts.toggle()
                    if !showsShortcuts { modifiers = [] }
                } label: {
                    Image(systemName: "command").frame(minWidth: 44, minHeight: 44)
                }
                .tint(showsShortcuts ? .blue : .secondary)
                .accessibilityLabel(showsShortcuts ? "收起快捷键" : "展开快捷键")
                .accessibilityIdentifier("remote-desktop-shortcuts-toggle")
                maskTextEntry(AnyView(TextField("输入文字…", text: $text)
                    .focused($textEntryFocused)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .onSubmit(commitText)
                    .accessibilityIdentifier("remote-desktop-text")))
                Button(action: commitText) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2).frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("发送")
                .disabled(text.isEmpty || session.state != .controllable)
                Button { showsKeyboard = false } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("收起远程键盘")
                .accessibilityIdentifier("remote-desktop-keyboard-close")
            }
        }.padding(.horizontal, 8).padding(.vertical, 4)
            .onAppear { textEntryFocused = true }
    }

    private var shortcuts: some View {
        VStack(spacing: 8) {
            HStack {
                modifier("⌘", value: .command)
                modifier("⌃", value: .control)
                modifier("⌥", value: .option)
                modifier("⇧", value: .shift)
                Spacer()
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
            .disabled(session.state != .controllable)
        }
        .accessibilityIdentifier("remote-desktop-shortcuts")
    }

    private func modifier(_ title: String, value: RemoteModifiers) -> some View {
        Button(title) {
            if modifiers.contains(value) { modifiers.remove(value) } else { modifiers.insert(value) }
        }.buttonStyle(.bordered).tint(modifiers.contains(value) ? .blue : .gray)
    }

    private func commitText() {
        guard !text.isEmpty, session.state == .controllable else { return }
        session.sendText(text)
        text = ""
    }
}

private struct RemoteKeyboardTop: PreferenceKey {
    static var defaultValue: CGFloat? { nil }
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}
