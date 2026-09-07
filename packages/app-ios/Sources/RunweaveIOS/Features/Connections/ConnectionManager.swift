import SwiftUI

struct ConnectionManager: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  @State private var editingID: String?
  @State private var name = ""
  @State private var url = ""
  @State private var failure: String?
  @State private var busy = false
  @State private var deleting: BackendConnection?
  @State private var checkingIDs = Set<String>()
  @State private var statuses: [String: String] = [:]
  @AppStorage("native.theme") private var theme = "dark"

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("外观")) {
          Picker("主题", selection: $theme) {
            Text("深色").tag("dark")
            Text("浅色").tag("light")
          }.pickerStyle(.segmented)
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
              if session.connection?.scope == connection.scope, !session.checking,
                !session.authenticated
              {
                Button("前往登录，加载项目和终端") { dismiss() }.buttonStyle(.borderless)
              }
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
      .toolbar { Button("关闭") { dismiss() }.disabled(busy) }
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
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy)
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
