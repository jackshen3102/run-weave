import SwiftUI

struct ConnectionDetailView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let codexQuota: CodexQuotaStore
  let connectionID: String
  let onFinish: () -> Void
  @StateObject private var batteries = ConnectionBatteryStore()
  @State private var editing = false
  @State private var deleting = false
  @State private var busy = false
  @State private var checking = false
  @State private var checkedStatus: String?
  @State private var failure: String?
  @State private var showingConfiguration = false
  @State private var showingCodexQuota = false

  private var connection: BackendConnection? { store.connections.first { $0.id == connectionID } }
  private var isCurrent: Bool { store.activeID == connectionID && session.connection?.id == connectionID }

  var body: some View {
    Form {
      if let connection {
        Section {
          VStack(alignment: .leading, spacing: 10) {
            Label(connection.name, systemImage: "desktopcomputer").font(.title3.bold())
            Text(status).font(.caption).foregroundColor(.secondary)
            if isCurrent, session.authenticated {
              DeviceBatteryView(device: session.deviceStatus)
            } else if let device = batteries.devices[connection.scope] {
              DeviceBatteryView(device: device)
            }
          }.padding(.vertical, 4)
          if !isCurrent || (!session.checking && !session.authenticated) {
            Button(isCurrent ? "前往登录，加载项目和终端" : "切换到这台电脑") { select(connection) }
          }
        }
        Section("连接") {
          NavigationLink {
            ConnectionRoutesView(store: store, session: session,
              resolver: ConnectionRouteResolver.forComputer(connection), onLoginRequired: onFinish)
          } label: {
            HStack {
              Label("连接线路", systemImage: "network")
              Spacer()
              Text(connection.automatic ? "自动选择" : "手动指定").foregroundColor(.secondary)
            }
          }.accessibilityIdentifier("connection-routes-" + connection.id)
          Button { check(connection) } label: {
            Label(checking ? "检测中…" : "检测连接", systemImage: "waveform.path.ecg")
          }.disabled(checking)
        }
        if isCurrent, session.authenticated {
          Section("这台电脑") {
            Button { showingConfiguration = true } label: { Label("电脑配置", systemImage: "gearshape") }
            Button { showingCodexQuota = true } label: { Label("Codex 额度", systemImage: "chart.bar") }
            Button {
              session.showingEnergyMonitor = true
              onFinish()
            } label: { Label("耗电监控", systemImage: "bolt") }
          }
        }
        Section {
          DeviceNotificationSettings(connection: connection,
            availability: batteries.notificationAvailability[connection.scope])
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        Section {
          Button("移除此连接", role: .destructive) { deleting = true }
            .accessibilityIdentifier("connection-remove")
        }
      } else { Text("连接已移除") }
    }
    .disabled(busy)
    .navigationTitle("连接详情").navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(busy || quickInputs.saving)
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        Button("编辑") { editing = true }.disabled(busy || connection == nil)
      }
    }
    .interactiveDismissDisabled(busy || quickInputs.saving)
    .task(id: connection) {
      if let connection { await batteries.refresh([connection]) }
    }
    .sheet(isPresented: $editing) { ConnectionEditorView(store: store, connectionID: connectionID) }
    .sheet(isPresented: $showingConfiguration) {
      ConfigurationView(session: session).mobileAnalyticsScreen(.configuration)
    }
    .sheet(isPresented: $showingCodexQuota) {
      CodexQuotaView(session: session, quota: codexQuota).mobileAnalyticsScreen(.codexQuota)
    }
    .confirmationDialog("删除本地连接？", isPresented: $deleting, titleVisibility: .visible) {
      if let connection {
        Button("删除 \(connection.name)", role: .destructive) { remove(connection) }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("将移除此连接、本地登录凭据及未发送草稿，并关闭这台电脑的提醒。电脑上的项目和终端会保留。")
    }
  }

  private var status: String {
    guard isCurrent else { return checkedStatus ?? "尚未检测" }
    switch session.health.status {
    case .checking: return "正在检测电脑…"
    case .offline: return session.health.message
    case .online: return session.authenticated ? "当前连接 · 已登录" : "电脑在线 · 需登录"
    }
  }

  private func select(_ connection: BackendConnection) {
    do { try store.select(connection.id); onFinish() }
    catch { failure = displayError(error) }
  }

  private func check(_ connection: BackendConnection) {
    checking = true
    failure = nil
    Task {
      defer { checking = false }
      do {
        if isCurrent { await session.refresh(); return }
        let base = try APIClient.normalize(connection.url)
        let snapshot = await DeviceHealthService.check(
          base: base, connectionID: APIClient.diagnosticConnectionID(base: base, id: connection.id))
        checkedStatus = snapshot.status == .online
          ? "电脑在线 · \(snapshot.latencyMilliseconds ?? 0) ms" : snapshot.message
      } catch { failure = displayError(error) }
    }
  }

  private func remove(_ connection: BackendConnection) {
    busy = true
    Task {
      defer { busy = false }
      do {
        session.forgetDrafts(connection)
        await NotificationCoordinator.shared.disable(connection)
        let credentials = try ComputerCredentialSession.shared(account: connection.credentialAccount)
        try await credentials.clear()
        try store.remove(connection.id)
        dismiss()
      } catch { failure = displayError(error) }
    }
  }
}
