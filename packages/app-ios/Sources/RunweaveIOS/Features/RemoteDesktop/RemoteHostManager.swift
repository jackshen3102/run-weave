import Clarity
import RunweaveRemoteDesktop
import SwiftUI

struct RemoteHostManager: View {
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let backendConnections: [BackendConnection]
  @State private var pairing = false
  @State private var editing: PairedRemoteHost?
  @State private var forgetting: PairedRemoteHost?
  @State private var failure: String?

  var body: some View {
    NavigationView {
      List {
        Section {
          Text("桌面直接连接已配对的 Mac，与 Runweave 后端的登录和在线状态分开。")
            .font(.footnote).foregroundColor(.secondary)
        }
        if let message = coordinator.storageError ?? failure {
          Section { Text(message).foregroundColor(.red) }
        }
        Section(header: Text("已配对 Mac")) {
          if coordinator.hosts.isEmpty { Text("尚未配对 Mac").foregroundColor(.secondary) }
          ForEach(coordinator.hosts) { host in
            HStack {
              Button { coordinator.open(host) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Label(host.target.name, systemImage: "display").clarityMask()
                  Text("\(host.target.host):\(host.target.port)")
                    .font(.caption).foregroundColor(.secondary)
                    .clarityMask()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
              }
              .accessibilityIdentifier("remote-host-open")
              Menu {
                Button("编辑地址与关联") { editing = host }
                Button("忘记本机配对", role: .destructive) { forgetting = host }
              } label: { Image(systemName: "ellipsis.circle") }
              .accessibilityLabel("管理桌面配对")
            }
          }
        }
        Section {
          Button { pairing = true } label: { Label("扫码配对 Mac", systemImage: "qrcode.viewfinder") }
            .accessibilityIdentifier("remote-host-pair")
            .disabled(coordinator.storageError != nil)
        } footer: {
          Text("忘记仅移除这部手机的专属凭据。要撤销设备授权，请在 Mac Host 本地撤销；本地停止可立即结束控制。")
        }
        Section {
          NavigationLink {
            RemoteUsageView(store: coordinator.usage)
          } label: { Label("桌面使用记录", systemImage: "clock.arrow.circlepath") }
          .accessibilityIdentifier("remote-usage-open")
        }
      }
      .navigationTitle("Mac 桌面")
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("完成") { coordinator.managingHosts = false }
        }
      }
      .sheet(isPresented: $pairing) {
        RemotePairHostScanView(coordinator: coordinator, backendConnections: backendConnections)
          .clarityMask().mobileAnalyticsScreen(.remotePairing)
      }
      .sheet(item: $editing) { host in
        RemoteHostEndpointView(coordinator: coordinator, host: host, backendConnections: backendConnections)
          .clarityMask().mobileAnalyticsScreen(.remoteHosts)
      }
      .confirmationDialog("忘记这部手机的 Mac 配对？", isPresented: Binding(
        get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }
      ), titleVisibility: .visible) {
        Button("忘记本机配对", role: .destructive) {
          guard let host = forgetting else { return }
          do {
            try RemoteCredentialStore().forget(target: host.target)
            try coordinator.removeMetadata(host.id)
            failure = nil
          } catch { failure = displayError(error) }
          forgetting = nil
        }
        Button("取消", role: .cancel) { forgetting = nil }
      } message: {
        Text("不会影响 Backend 登录或其他 Mac。Host 本地授权需在 Mac 上另行撤销。")
      }
    }
    .navigationViewStyle(.stack)
    .clarityMask()
  }
}

struct RemotePairHostView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let backendConnections: [BackendConnection]
  var onPaired: ((PairedRemoteHost) -> Void)? = nil
  @State private var name = ""
  @State private var host = ""
  @State private var port = String(RemoteTarget.computerPort)
  @State private var fingerprint = ""
  @State private var code = ""
  @State private var backendConnectionID = ""
  @State private var submitting = false
  @State private var waitingForConfirmation = false
  @State private var failure: String?
  @State private var operation: Task<Void, Never>?

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("机器名称", text: $name).clarityMask()
          TextField("局域网 IP 或主机名", text: $host).textInputAutocapitalization(.never)
            .disableAutocorrection(true).keyboardType(.URL)
            .clarityMask()
          TextField("端口", text: $port).keyboardType(.numberPad).clarityMask()
          TextField("证书 SHA-256 指纹", text: $fingerprint).textInputAutocapitalization(.never)
            .disableAutocorrection(true)
            .clarityMask()
        } header: {
          Text("Mac Host 显示的连接信息")
        } footer: {
          Text("在 Mac 本地核对指纹，再输入一次性配对码。地址不会从 Backend 连接推导。")
        }
        Section(header: Text("首次授权")) {
          SecureField("一次性配对码", text: $code).keyboardType(.numberPad).clarityMask()
          Text("提交后仍需在 Mac 本地确认这部手机。")
            .font(.footnote).foregroundColor(.secondary)
        }
        Section(header: Text("终端快捷入口（可选）")) {
          backendPicker(selection: $backendConnectionID, connections: backendConnections)
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        if waitingForConfirmation { Section { Text("等待 Mac 本地确认…") } }
      }
      .disabled(submitting)
      .clarityMask()
      .navigationTitle("配对 Mac")
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) {
          Button("取消") { operation?.cancel(); code = ""; dismiss() }
        }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button(action: pair) {
            if submitting { ProgressView() } else { Text("配对") }
          }
          .disabled(submitting || coordinator.storageError != nil)
          .accessibilityIdentifier("remote-pair-submit")
        }
      }
    }
    .navigationViewStyle(.stack)
    .clarityMask()
    .onDisappear { operation?.cancel(); code = "" }
    .onChange(of: scenePhase) { phase in
      if phase != .active { operation?.cancel(); code = "" }
    }
  }

  private func pair() {
    failure = nil
    do {
      let value = try configuredTarget(id: UUID(), name: name, host: host, port: port,
        fingerprint: fingerprint, credentialsReference: nil)
      let pairingCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
      guard pairingCode.count == 6, pairingCode.allSatisfy({ $0.isASCII && $0.isNumber }) else {
        throw MobileLoginFailure(message: "请输入 Mac 显示的六位一次性配对码。")
      }
      let epoch = coordinator.generation
      let association = backendConnectionID.isEmpty ? nil : backendConnectionID
      submitting = true
      waitingForConfirmation = false
      operation = Task { @MainActor in
        defer { submitting = false; waitingForConfirmation = false; code = ""; operation = nil }
        do {
          let paired = try await RemotePairingClient().pair(target: value, code: pairingCode,
            deviceName: "Runweave iPhone", onWaitingForConfirmation: {
              guard coordinator.generation == epoch, !Task.isCancelled else { return }
              waitingForConfirmation = true
            })
          guard coordinator.generation == epoch, !Task.isCancelled else {
            try? RemoteCredentialStore().forget(target: paired)
            return
          }
          let saved = try coordinator.savePairing(paired, backendConnectionID: association)
          onPaired?(saved)
          dismiss()
        } catch {
          guard coordinator.generation == epoch, !Task.isCancelled, !(error is CancellationError) else { return }
          failure = displayError(error)
        }
      }
    } catch { failure = displayError(error) }
  }
}

private struct RemoteHostEndpointView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let host: PairedRemoteHost
  let backendConnections: [BackendConnection]
  @State private var name: String
  @State private var address: String
  @State private var port: String
  @State private var useRelay: Bool
  @State private var relayAddress: String
  @State private var relayPort: String
  @State private var backendConnectionID: String
  @State private var failure: String?

  init(coordinator: RemoteDesktopCoordinator, host: PairedRemoteHost, backendConnections: [BackendConnection]) {
    self.coordinator = coordinator
    self.host = host
    self.backendConnections = backendConnections
    _name = State(initialValue: host.target.name)
    _address = State(initialValue: host.target.host)
    _port = State(initialValue: String(host.target.port))
    _useRelay = State(initialValue: host.target.usesRelay)
    _relayAddress = State(initialValue: host.target.relay?.host ?? "")
    _relayPort = State(initialValue: String(host.target.relay?.port ?? 15446))
    _backendConnectionID = State(initialValue: host.backendConnectionID ?? "")
  }

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("机器名称", text: $name).clarityMask()
          TextField("局域网 IP 或主机名", text: $address).textInputAutocapitalization(.never)
            .disableAutocorrection(true).keyboardType(.URL)
            .clarityMask()
          TextField("端口", text: $port).keyboardType(.numberPad).clarityMask()
          Text("证书指纹：\(host.target.certificateFingerprint)").font(.caption).textSelection(.enabled)
            .clarityMask()
        } header: {
          Text("同一台 Mac 的地址")
        } footer: {
          Text("修改地址保留原 Host 身份与指纹。若 Mac 身份改变，必须重新配对。")
        }
        Section {
          Toggle("通过 Runweave 隧道连接", isOn: $useRelay)
            .accessibilityIdentifier("remote-host-use-relay")
          if useRelay {
            TextField("中转服务器内网 IPv4", text: $relayAddress).textInputAutocapitalization(.never)
              .disableAutocorrection(true).keyboardType(.decimalPad).clarityMask()
            TextField("远控端口", text: $relayPort).keyboardType(.numberPad).clarityMask()
          }
        } header: { Text("远程访问") } footer: {
          Text("填写 Runweave「端口与隧道」中的 RemoteDesk 地址和端口。Mac 上需保持 Runweave 与 RemoteDesk 共享运行，手机需接入对应网络或 VPN。使用原配对身份；关闭此项恢复局域网连接，保留已保存的中转配置。")
        }
        Section(header: Text("终端快捷入口（可选）")) {
          backendPicker(selection: $backendConnectionID, connections: backendConnections)
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
      }
      .navigationTitle("桌面地址")
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("保存") {
            do {
              let configured = try configuredTarget(id: host.id, name: name, host: address, port: port,
                fingerprint: host.target.certificateFingerprint, credentialsReference: host.target.credentialsReference)
              var target = host.target
              target.name = configured.name
              target.host = configured.host
              target.port = configured.port
              target.relayEnabled = useRelay
              if useRelay {
                guard let relayPort = UInt16(relayPort.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                  throw MobileLoginFailure(message: "请输入有效的中转端口。")
                }
                let relay = RemoteRelayEndpoint(host: relayAddress.trimmingCharacters(in: .whitespacesAndNewlines), port: relayPort)
                guard relay.isValid else { throw MobileLoginFailure(message: "请输入中转服务器的内网 IPv4 和 1024–65535 端口。") }
                target.relay = relay
              }
              try coordinator.save(PairedRemoteHost(target: target,
                backendConnectionID: backendConnectionID.isEmpty ? nil : backendConnectionID))
              dismiss()
            } catch { failure = displayError(error) }
          }
        }
      }
    }
    .navigationViewStyle(.stack)
    .clarityMask()
  }
}

func backendPicker(selection: Binding<String>, connections: [BackendConnection]) -> some View {
  Picker("关联 Backend", selection: selection) {
    Text("不关联").tag("")
    ForEach(connections) { Text($0.name).clarityMask().tag($0.id) }
  }
  .clarityMask()
}

private func configuredTarget(id: UUID, name: String, host: String, port: String,
  fingerprint: String, credentialsReference: String?) throws -> RemoteTarget {
  let address = host.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !address.isEmpty, !address.contains("/"), !address.contains("@"),
    address.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
    let number = UInt16(port.trimmingCharacters(in: .whitespacesAndNewlines)), number > 0 else {
    throw MobileLoginFailure(message: "请输入独立 Mac Host 的局域网地址与有效端口。")
  }
  let pin = fingerprint.lowercased().filter { $0 != ":" && !$0.isWhitespace }
  guard pin.count == 64, pin.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
    throw MobileLoginFailure(message: "请核对 Mac 显示的完整 SHA-256 证书指纹。")
  }
  let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
  return RemoteTarget(id: id, name: label.isEmpty ? address : label, host: address, port: number,
    certificateFingerprint: pin, credentialsReference: credentialsReference)
}
