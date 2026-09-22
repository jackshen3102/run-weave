import IOSBuildIdentity
import SwiftUI

struct ConnectionManager: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var quickReplies: LocalQuickReplyStore
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let codexQuota: CodexQuotaStore
  var onMobileLogin: () -> Void = {}
  @StateObject private var batteries = ConnectionBatteryStore()
  @State private var scanning = false
  @State private var showingBuildIdentity = false
  @State private var showingCodexQuota = false
  @State private var editingID: String?
  @State private var name = ""
  @State private var url = ""
  @State private var failure: String?
  @State private var busy = false
  @State private var deleting: BackendConnection?
  @State private var checkingIDs = Set<String>()
  @State private var statuses: [String: String] = [:]
  @AppStorage("native.theme") private var theme = "dark"
  @AppStorage(ScreenAwakeModifier.preferenceKey) private var keepScreenAwake = true

  var body: some View {
    NavigationView {
      Form {
        Section {
          Button { scanning = true } label: {
            Label("扫码连接电脑", systemImage: "qrcode.viewfinder").font(.headline)
          }.disabled(store.storageError != nil)
        }
        Section {
          NavigationLink {
            QuickReplyLibraryView()
          } label: {
            Label("快捷回复", systemImage: "text.badge.plus")
          }.accessibilityIdentifier("connection-quick-replies")
        }
        if session.authenticated {
          Section(header: Text(session.connection?.name ?? "当前电脑")) {
            Button("Codex 额度") { showingCodexQuota = true }
          }
        }
        Section { Button("构建信息") { showingBuildIdentity = true } }
        Section(header: Text("外观")) {
          Picker("主题", selection: $theme) {
            Text("深色").tag("dark")
            Text("浅色").tag("light")
          }.pickerStyle(.segmented)
        }
        Section(
          header: Text("屏幕"),
          footer: Text("在 Runweave 前台使用期间防止自动息屏。离开应用后恢复系统设置，开启会增加耗电。")
        ) {
          Toggle("保持屏幕常亮", isOn: $keepScreenAwake)
            .accessibilityIdentifier("keep-screen-awake")
        }
        if let error = store.storageError { Section { Text(error).foregroundColor(.red) } }
        Section(header: Text("Backend")) {
          if store.connections.isEmpty { Text("先添加一个 Runweave 后端连接。") }
          ForEach(store.connections) { connection in
            VStack(alignment: .leading, spacing: 10) {
              Button {
                do { try store.select(connection.id) } catch { failure = displayError(error) }
              } label: {
                HStack {
                  VStack(alignment: .leading) {
                    Text(connection.name).font(.headline)
                    Text(connection.url).font(.caption).foregroundColor(.secondary)
                  }
                  Spacer()
                  if connection.id == store.activeID { Image(systemName: "checkmark.circle.fill") }
                }
              }
              Text(connectionStatus(connection)).font(.caption)
              if session.connection?.scope == connection.scope, session.authenticated {
                DeviceBatteryView(device: session.deviceStatus)
              } else if let device = batteries.devices[connection.scope] {
                DeviceBatteryView(device: device)
              }
              if session.connection?.scope == connection.scope, !session.checking,
                !session.authenticated
              {
                Button("前往登录，加载项目和终端") { dismiss() }.buttonStyle(.borderless)
              }
              DeviceNotificationSettings(connection: connection, availability: batteries.notificationAvailability[connection.scope])
              HStack {
                Button(checkingIDs.contains(connection.id) ? "检测中" : "检测") { check(connection) }
                  .disabled(checkingIDs.contains(connection.id))
                Button("编辑") {
                  editingID = connection.id
                  name = connection.name
                  url = connection.url
                  failure = nil
                }
                Button("删除", role: .destructive) { deleting = connection }
              }.buttonStyle(.borderless)
            }.padding(.vertical, 4)
          }
        }
        Section(header: Text(editingID == nil ? "新增连接" : "编辑连接")) {
          TextField("名称", text: $name)
          TextField("URL", text: $url).keyboardType(.URL).autocapitalization(.none)
            .disableAutocorrection(true)
          if let failure { Text(failure).foregroundColor(.red) }
          Button(editingID == nil ? "添加并切换" : "保存") { save() }.disabled(
            url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.storageError != nil
          )
          if editingID != nil { Button("取消编辑") { reset() } }
        }
      }
      .disabled(busy)
      .navigationTitle("连接管理")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("关闭") { dismiss() }.disabled(busy || quickReplies.saving) }
      .confirmationDialog(
        "删除本地连接？",
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
        titleVisibility: .visible
      ) {
        if let connection = deleting {
          Button("删除 \(connection.name)", role: .destructive) { remove(connection) }
        }
        Button("取消", role: .cancel) { deleting = nil }
      } message: {
        Text("将移除此连接和它的本地登录凭据，远端项目和终端会保留。")
      }
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy || quickReplies.saving)
      .task(id: store.connections.map(\.scope).joined(separator: "|") + "|" + (store.activeID ?? "")) {
        let ordered = store.connections.filter { $0.id == store.activeID }
          + store.connections.filter { $0.id != store.activeID }
        await batteries.refresh(ordered)
      }
      .preferredColorScheme(theme == "light" ? .light : .dark)
      .sheet(isPresented: $showingCodexQuota) {
        CodexQuotaView(session: session, quota: codexQuota)
      }
      .sheet(isPresented: $showingBuildIdentity) { BuildIdentityView() }
      .sheet(isPresented: $scanning) {
        MobileLoginView(store: store, session: session) {
          scanning = false
          onMobileLogin()
          dismiss()
        }
      }
  }

  private func connectionStatus(_ connection: BackendConnection) -> String {
    if session.connection?.scope == connection.scope {
      switch session.health.status {
      case .checking: return "正在检测电脑…"
      case .offline: return session.health.message
      case .online:
        return session.authenticated ? "电脑在线 · 已登录" : "电脑在线 · 尚未登录"
      }
    }
    return statuses[connection.scope] ?? "尚未检测"
  }

  private func check(_ connection: BackendConnection) {
    checkingIDs.insert(connection.id)
    Task {
      do {
        if session.connection?.scope == connection.scope {
          await session.refresh()
          checkingIDs.remove(connection.id)
          return
        }
        let snapshot = await DeviceHealthService.check(
          base: try APIClient.normalize(connection.url))
        if store.connections.contains(where: { $0.scope == connection.scope }) {
          statuses[connection.scope] =
            snapshot.status == .online
            ? "Online · \(snapshot.latencyMilliseconds ?? 0)ms" : snapshot.message
        }
      } catch { failure = displayError(error) }
      checkingIDs.remove(connection.id)
    }
  }

  private func clear(_ connection: BackendConnection) async throws {
    let client: APIClient
    if session.connection?.scope == connection.scope, let active = session.api {
      client = active
    } else {
      client = try APIClient(base: connection.url, connectionID: connection.id)
    }
    session.forgetDrafts(connection)
    await NotificationCoordinator.shared.disable(connection, client: client)
    try await client.clearCredentials()
  }

  private func save() {
    busy = true
    failure = nil
    Task {
      do {
        let normalized = try APIClient.normalize(url).absoluteString
        if let id = editingID, let old = store.connections.first(where: { $0.id == id }),
          old.url != normalized
        {
          try await clear(old)
        }
        try store.save(id: editingID, name: name, url: normalized)
        reset()
      } catch { failure = displayError(error) }
      busy = false
    }
  }

  private func remove(_ connection: BackendConnection) {
    busy = true
    Task {
      do {
        try await clear(connection)
        try store.remove(connection.id)
        if editingID == connection.id { reset() }
      } catch { failure = displayError(error) }
      deleting = nil
      busy = false
    }
  }
  private func reset() {
    editingID = nil
    name = ""
    url = ""
    failure = nil
  }
}
