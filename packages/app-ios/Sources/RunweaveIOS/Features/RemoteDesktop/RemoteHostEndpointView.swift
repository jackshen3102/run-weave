import Clarity
import RunweaveRemoteDesktop
import SwiftUI

struct RemoteHostEndpointView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let host: PairedRemoteHost
  let backendConnections: [BackendConnection]
  @State private var name: String
  @State private var localAddresses: [RemoteAddressDraft]
  @State private var useRelay: Bool
  @State private var relayAddresses: [RemoteAddressDraft]
  @State private var backendConnectionID: String
  @State private var failure: String?

  init(coordinator: RemoteDesktopCoordinator, host: PairedRemoteHost, backendConnections: [BackendConnection]) {
    self.coordinator = coordinator
    self.host = host
    self.backendConnections = backendConnections
    _name = State(initialValue: host.target.name)
    _localAddresses = State(initialValue: host.target.localEndpoints.map { RemoteAddressDraft(host: $0.host, port: $0.port) })
    _useRelay = State(initialValue: host.target.allowsRelayFallback)
    _relayAddresses = State(initialValue: host.target.relayEndpoints.map { RemoteAddressDraft(host: $0.host, port: $0.port) })
    _backendConnectionID = State(initialValue: host.backendConnectionID ?? "")
  }

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("机器名称", text: $name).clarityMask()
          Text("证书指纹：\(host.target.certificateFingerprint)").font(.caption).textSelection(.enabled)
            .clarityMask()
        } footer: {
          Text("所有地址必须属于同一台 Mac，沿用原 Host 身份与指纹。若 Mac 身份改变，必须重新配对。")
        }
        Section {
          RemoteAddressRows(addresses: $localAddresses, relay: false)
        } header: { Text("局域网地址") } footer: {
          Text("先尝试局域网发现，再按以下顺序连接。可添加这台 Mac 在不同网络中的 IP 或主机名。")
        }
        Section {
          Toggle("允许隧道备用连接", isOn: $useRelay)
            .accessibilityIdentifier("remote-host-use-relay")
          if useRelay {
            RemoteAddressRows(addresses: $relayAddresses, relay: true)
          }
        } header: { Text("隧道备用地址") } footer: {
          Text("局域网地址均超时或不可达时，按顺序尝试隧道。填写 Runweave「端口与隧道」中的 RemoteDesk 内网 IPv4 和端口；Mac 需保持 Runweave 与 RemoteDesk 共享运行，手机需接入对应网络或 VPN。关闭后保留已保存的隧道地址。证书校验失败时停止连接。")
        }
        Section(header: Text("终端快捷入口（可选）")) {
          backendPicker(selection: $backendConnectionID, connections: backendConnections)
        }
      }
      .navigationTitle("桌面地址")
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("保存", action: save).accessibilityIdentifier("remote-host-addresses-save")
        }
      }
    }
    .navigationViewStyle(.stack)
    .clarityMask()
    .alert("无法保存桌面地址", isPresented: Binding(
      get: { failure != nil }, set: { if !$0 { failure = nil } }
    )) {
      Button("好", role: .cancel) { failure = nil }
    } message: { Text(failure ?? "") }
  }

  private func save() {
    do {
      let locals = try validated(localAddresses, relay: false)
      guard let first = locals.first else { throw MobileLoginFailure(message: "请保留至少一个局域网地址。") }
      let configured = try configuredTarget(id: host.id, name: name, host: first.host, port: String(first.port),
        fingerprint: host.target.certificateFingerprint, credentialsReference: host.target.credentialsReference)
      var target = host.target
      target.name = configured.name
      target.host = first.host
      target.port = first.port
      target.additionalLocalEndpoints = Array(locals.dropFirst())
      target.relayEnabled = useRelay
      if useRelay {
        let relays = try validated(relayAddresses, relay: true).map { RemoteRelayEndpoint(host: $0.host, port: $0.port) }
        guard let firstRelay = relays.first else { throw MobileLoginFailure(message: "请添加至少一个隧道备用地址。") }
        target.relay = firstRelay
        target.additionalRelayEndpoints = Array(relays.dropFirst())
      }
      try coordinator.save(PairedRemoteHost(target: target,
        backendConnectionID: backendConnectionID.isEmpty ? nil : backendConnectionID))
      dismiss()
    } catch { failure = displayError(error) }
  }

  private func validated(_ drafts: [RemoteAddressDraft], relay: Bool) throws -> [RemoteHostEndpoint] {
    var seen = Set<RemoteHostEndpoint>()
    return try drafts.enumerated().map { index, draft in
      let address = draft.host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let label = "\(relay ? "隧道" : "局域网")地址 \(index + 1)"
      guard let port = UInt16(draft.port.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        throw MobileLoginFailure(message: "\(label)：请输入有效端口。")
      }
      let endpoint = RemoteHostEndpoint(host: address, port: port)
      guard endpoint.isValid else { throw MobileLoginFailure(message: "\(label)：请输入 IP 或主机名和 1–65535 端口，不包含 URL 路径。") }
      if relay, !RemoteRelayEndpoint(host: address, port: port).isValid {
        throw MobileLoginFailure(message: "\(label)：请输入内网 IPv4 和 1024–65535 端口。")
      }
      guard seen.insert(endpoint).inserted else { throw MobileLoginFailure(message: "\(label)：此地址和端口已存在。") }
      return endpoint
    }
  }
}

private struct RemoteAddressDraft: Identifiable {
  let id = UUID()
  var host: String
  var port: String
  init(host: String = "", port: UInt16) { self.host = host; self.port = String(port) }
}

private struct RemoteAddressRows: View {
  @Binding var addresses: [RemoteAddressDraft]
  let relay: Bool
  private var kind: String { relay ? "隧道" : "局域网" }
  private var prefix: String { relay ? "remote-relay" : "remote-local" }

  var body: some View {
    ForEach($addresses) { $address in
      let index = addresses.firstIndex(where: { $0.id == address.id }) ?? 0
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text("\(kind)地址 \(index + 1)").font(.subheadline).foregroundColor(.secondary)
          Spacer()
          Button { addresses.swapAt(index, index - 1) } label: {
            Image(systemName: "arrow.up").frame(width: 44, height: 44).contentShape(Rectangle())
          }
            .disabled(index == 0).accessibilityLabel("上移\(kind)地址 \(index + 1)")
          Button { addresses.swapAt(index, index + 1) } label: {
            Image(systemName: "arrow.down").frame(width: 44, height: 44).contentShape(Rectangle())
          }
            .disabled(index == addresses.count - 1).accessibilityLabel("下移\(kind)地址 \(index + 1)")
          Button(role: .destructive) { addresses.removeAll { $0.id == address.id } } label: {
            Image(systemName: "minus.circle").frame(width: 44, height: 44).contentShape(Rectangle())
          }.disabled(!relay && addresses.count == 1)
            .accessibilityLabel("删除\(kind)地址 \(index + 1)")
        }.buttonStyle(.borderless)
        TextField(relay ? "中转服务器内网 IPv4" : "局域网 IP 或主机名", text: $address.host)
          .textInputAutocapitalization(.never).disableAutocorrection(true).keyboardType(.URL).clarityMask()
          .accessibilityIdentifier("\(prefix)-host-\(index)")
        TextField("端口", text: $address.port).keyboardType(.numberPad).clarityMask()
          .accessibilityIdentifier("\(prefix)-port-\(index)")
      }.padding(.vertical, 4)
    }
    Button {
      addresses.append(RemoteAddressDraft(port: relay ? 15446 : RemoteTarget.computerPort))
    } label: { Label("添加\(kind)地址", systemImage: "plus.circle") }
      .accessibilityIdentifier("\(prefix)-add")
  }
}
