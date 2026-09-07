#if NATIVE_DIAGNOSTICS
  import SwiftUI
  import RunweaveIOS

  /// Internal, non-sensitive fixtures. Never compiled into Release.
  struct TerminalProbe: View {
    @StateObject private var model = ProbeModel()
    @State private var live = false

    var body: some View {
      VStack(spacing: 8) {
        Text("SwiftTerm 1.19.0").font(.headline)
        Button("连接真实会话") { live = true }
        Text(model.status).font(.caption).accessibilityIdentifier("probe-status")
        HStack {
          Button("Unicode / ANSI") { model.replay() }
          Button("Metal") { model.metal(fail: false) }
          Button("模拟失败") { model.metal(fail: true) }
        }.buttonStyle(.bordered)
        TerminalHostView(surface: model.surface)
        Button("导出诊断") { model.export() }.buttonStyle(.bordered)
      }
      .padding(.top)
      .sheet(item: $model.exportFile) { file in ActivitySheet(url: file.url) }
      .fullScreenCover(isPresented: $live) { LiveTerminalProbe() }
    }
  }

  @MainActor
  private final class ProbeModel: ObservableObject {
    let surface = SwiftTermSurface()
    @Published var status = "CoreGraphics · 尚未重放"
    @Published var exportFile: ExportFile?
    private var events: [[String: Any]] = []

    init() {
      surface.viewportChanged = { [weak self] cols, rows in
        self?.events.append([
          "event": "resize", "cols": cols, "rows": rows,
          "uptime": ProcessInfo.processInfo.systemUptime,
        ])
      }
    }

    func replay() {
      surface.reset()
      // Split both UTF-8 scalars and an ANSI sequence; the parser must retain state across feeds.
      let bytes = Array(
        "\u{1b}[2J\u{1b}[H中文 e\u{301} 👩‍💻\r\n\u{1b}[31mRED\u{1b}[0m\r\n\u{1b}[4;1HCURSOR\r\n".utf8)
      for (index, byte) in bytes.enumerated() {
        surface.feed([byte])
        events.append([
          "event": "fixture.consume", "sequence": index, "bytes": 1,
          "uptime": ProcessInfo.processInfo.systemUptime,
        ])
      }
      let terminal = surface.terminalView.getTerminal()
      let cursor = terminal.getCursorLocation()
      status =
        "\(surface.renderer) · \(surface.consumedBytes) bytes · \(bytes.count) chunks · \(terminal.cols)×\(terminal.rows) · cursor \(cursor.x),\(cursor.y)"
    }

    func metal(fail: Bool) {
      do {
        if fail { throw ProbeError.injectedMetalFailure }
        try surface.setMetal(true)
        replay()
      } catch {
        do {
          try surface.setMetal(false)
          status = "Metal 初始化失败 · 已回退 CoreGraphics"
        } catch { status = "Renderer 初始化失败" }
      }
    }

    func export() {
      do {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
          "native-probe-\(UUID()).json")
        let terminal = surface.terminalView.getTerminal()
        let cursor = terminal.getCursorLocation()
        let payload: [String: Any] = [
          "client": "native-ios", "renderer": surface.renderer,
          "rendererVersion": "1.19.0", "backendVersion": "unknown",
          "fixture": "unicode-ansi-v1", "events": events,
          "cols": terminal.cols, "rows": terminal.rows,
          "cursorX": cursor.x, "cursorY": cursor.y,
          "fontSize": 14, "fontFamily": "monospacedSystemFont",
          // This probe contains only the fixed public fixture, never live session output.
          "lines": (0..<5).map { row in
            terminal.bufferLine(atRow: row)?.translateToString(
              trimRight: true, skipNullCellsFollowingWide: true,
              characterProvider: { terminal.getCharacter(for: $0) }) ?? ""
          },
          "firstRowCells": (0..<min(16, terminal.cols)).map { col in
            [
              "column": col,
              "character": terminal.getCharacter(col: col, row: 0).map(String.init) ?? "",
              "width": terminal.bufferLine(atRow: 0)?.getWidth(index: col) ?? 0,
            ] as [String: Any]
          },
        ]
        try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
          .write(to: url)
        exportFile = ExportFile(url: url)
      } catch { status = "诊断导出失败" }
    }
  }

  private enum ProbeError: Error { case injectedMetalFailure }
  private struct ExportFile: Identifiable {
    let id = UUID()
    let url: URL
  }
  private struct ActivitySheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
      UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
  }

  private struct LiveTerminalProbe: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("probe.backend") private var base = ""
    @AppStorage("probe.terminal") private var terminalID = ""
    // Optional simulator launch environment; never persisted, exported or included in Release.
    @State private var username =
      ProcessInfo.processInfo.environment["RUNWEAVE_PROBE_USERNAME"] ?? ""
    @State private var password =
      ProcessInfo.processInfo.environment["RUNWEAVE_PROBE_PASSWORD"] ?? ""
    @State private var readOnly = false
    @State private var failure: String?
    @State private var busy = false
    @State private var operation: Task<Void, Never>?
    @State private var controller: SessionController?

    var body: some View {
      NavigationView {
        Group {
          if let controller {
            LiveSessionView(controller: controller)
          } else {
            Form {
              TextField("Backend URL", text: $base).keyboardType(.URL).autocapitalization(.none)
              TextField("用户名", text: $username).autocapitalization(.none)
              SecureField("密码（已有登录时留空）", text: $password)
              TextField("terminalSessionId", text: $terminalID).autocapitalization(.none)
              Toggle("只读观察（不发送输入和 resize）", isOn: $readOnly)
              Button(busy ? "连接中…" : "连接") { open() }
                .disabled(busy || base.isEmpty || terminalID.isEmpty)
              if let failure { Text(failure).foregroundColor(.red) }
            }.disabled(busy)
          }
        }
        .navigationTitle("终端实验室 · 真实会话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          Button("关闭") {
            operation?.cancel()
            controller?.dispose()
            dismiss()
          }
        }
      }
      .navigationViewStyle(.stack)
      .onDisappear {
        operation?.cancel()
        controller?.dispose()
      }
    }

    private func open() {
      busy = true
      failure = nil
      operation = Task { @MainActor in
        defer { busy = false }
        do {
          let api = try APIClient(base: base, connectionID: "terminal-probe")
          if !password.isEmpty { try await api.login(username: username, password: password) }
          guard !Task.isCancelled else { return }
          password = ""
          let next = SessionController(api: api, terminalID: terminalID, readOnly: readOnly)
          controller = next
          next.connect()
        } catch let error as APIError { failure = error.localizedDescription } catch {
          failure = "连接失败，请检查网络和服务地址"
        }
      }
    }
  }

  private struct LiveSessionView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @ObservedObject var controller: SessionController
    @StateObject private var performance = TerminalPerformanceCapture()
    @State private var input = ""
    @State private var exportFile: ExportFile?
    @State private var exportFailure: String?

    var body: some View {
      VStack(spacing: 6) {
        Text(
          "\(controller.connectionStatus) · \(controller.runtimeKind ?? "unknown") · \(controller.runtimeStatus ?? "unknown")"
        ).font(.caption)
        if verticalSizeClass != .compact {
          Text("接收 \(controller.receivedBytes) B · 队列 \(controller.queuedBytes) B").font(.caption2)
        }
        if let failure = controller.failure { Text(failure).foregroundColor(.red).font(.caption) }
        if verticalSizeClass != .compact {
          HStack {
            Button("重连") { controller.connect() }
            Button("断开") { controller.disconnect() }
            Button("导出") { export() }
            Button("回到底部") { controller.returnToBottom() }.disabled(!controller.canSend)
          }.buttonStyle(.bordered)
        }
        HStack {
          Button(performance.running ? "结束性能采样" : "开始性能采样") {
            if performance.running { performance.stop() } else { performance.start(controller) }
          }
          Text(performance.status).font(.caption2)
        }
        TerminalHostView(surface: controller.surface)
        if verticalSizeClass != .compact {
          HStack {
            Button("Esc") { controller.sendRaw("\u{1b}") }
            Button("Ctrl-C") { controller.sendRaw("\u{03}") }
            Button("Enter") { controller.sendRaw("\r") }
            Button("键盘") { controller.surface.terminalView.becomeFirstResponder() }
          }.disabled(!controller.canSend)
          HStack {
            TextField("验证输入", text: $input).textFieldStyle(.roundedBorder).autocapitalization(.none)
              .disableAutocorrection(true)
            Button("发送") { controller.sendVerificationLine(input) }.disabled(!controller.canSend)
          }.padding(.horizontal)
        }
        if let exportFailure { Text(exportFailure).font(.caption) }
      }
      .sheet(item: $exportFile) { file in ActivitySheet(url: file.url) }
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) {
          Button {
            controller.surface.view.window?.endEditing(true)
          } label: {
            Image(systemName: "keyboard.chevron.compact.down")
          }.accessibilityLabel("收起键盘")
        }
      }
      .onDisappear { performance.stop() }
      .onChange(of: scenePhase) { phase in
        if phase == .active {
          controller.connect()
        } else if phase == .background {
          controller.disconnect()
        }
      }
    }

    private func export() {
      do {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
          "native-session-\(UUID()).json")
        try JSONSerialization.data(
          withJSONObject: ["client": "native-ios", "events": controller.events],
          options: [.prettyPrinted, .sortedKeys]
        ).write(to: url)
        exportFile = ExportFile(url: url)
      } catch { exportFailure = "诊断导出失败" }
    }
  }
#endif
