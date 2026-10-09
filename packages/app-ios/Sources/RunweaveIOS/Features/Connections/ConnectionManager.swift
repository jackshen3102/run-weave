import SwiftUI

/// The frequent action is selecting a computer. Management stays in its detail page.
struct ConnectionManager: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let codexQuota: CodexQuotaStore
  var onMobileLogin: () -> Void = {}
  @State private var detailID: String?
  @State private var adding = false
  @State private var failure: String?

  private var orderedConnections: [BackendConnection] {
    store.connections.filter { $0.id == store.activeID } + store.connections.filter { $0.id != store.activeID }
  }

  var body: some View {
    NavigationView {
      List {
        if let error = store.storageError {
          Section { Text(error).foregroundColor(.red) }
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        if store.connections.isEmpty {
          ConnectionAddActions(disabled: store.storageError != nil, store: store, session: session,
            onMobileLogin: onMobileLogin, onConnected: { dismiss() })
        } else {
          Section {
            ForEach(orderedConnections) { connection in
              connectionRow(connection)
            }
          }
          Section {
            Button { adding = true } label: {
              Label {
                VStack(alignment: .leading, spacing: 4) {
                  Text("添加连接")
                  Text("扫码连接电脑或手动添加").font(.caption).foregroundColor(.secondary)
                }
              } icon: { Image(systemName: "plus.circle") }
            }.disabled(store.storageError != nil).accessibilityIdentifier("connection-add")
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("切换连接")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          if detailID == nil { Button("关闭") { dismiss() } }
        }
      }
    }
    .navigationViewStyle(.stack)
    .onChange(of: store.connections.map(\.id)) { ids in
      if let detailID, !ids.contains(detailID) { self.detailID = nil }
    }
    .modifier(ConnectionPickerPresentation(expanded: detailID != nil || store.connections.isEmpty))
    .sheet(isPresented: $adding) {
      ConnectionAddView(store: store, session: session, onMobileLogin: onMobileLogin,
        onConnected: { adding = false; dismiss() })
    }
  }

  private func connectionRow(_ connection: BackendConnection) -> some View {
    HStack(spacing: 4) {
      Button { select(connection) } label: {
        HStack(spacing: 12) {
          Image(systemName: "desktopcomputer").font(.title3).foregroundColor(.secondary)
          VStack(alignment: .leading, spacing: 4) {
            Text(connection.name).font(.headline).foregroundColor(.primary)
            Text(status(connection)).font(.caption).foregroundColor(.secondary)
          }
          Spacer(minLength: 8)
          if connection.id == store.activeID {
            Image(systemName: "checkmark.circle.fill").foregroundColor(.accentColor)
          }
        }.frame(maxWidth: .infinity, minHeight: 52, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("connection-select-" + connection.id)
      .accessibilityHint("切换到这台电脑并关闭列表")
      Button { detailID = connection.id } label: {
        Image(systemName: "info.circle").font(.title3).frame(width: 44, height: 44)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("查看 \(connection.name) 连接详情")
      .accessibilityIdentifier("connection-detail-" + connection.id)
    }
    .background {
      NavigationLink(tag: connection.id, selection: $detailID) {
        ConnectionDetailView(store: store, session: session, codexQuota: codexQuota,
          connectionID: connection.id, onFinish: { dismiss() })
      } label: { EmptyView() }.hidden()
    }
  }

  private func select(_ connection: BackendConnection) {
    do { try store.select(connection.id); dismiss() }
    catch { failure = displayError(error) }
  }

  private func status(_ connection: BackendConnection) -> String {
    guard session.connection?.scope == connection.scope else { return "尚未检测" }
    switch session.health.status {
    case .checking: return "正在连接…"
    case .offline: return session.health.message
    case .online: return session.authenticated ? "当前 · 已登录" : "需登录"
    }
  }
}

private struct ConnectionPickerPresentation: ViewModifier {
  let expanded: Bool
  func body(content: Content) -> some View {
    if #available(iOS 16.0, *) {
      content.presentationDetents(expanded ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
    } else { content }
  }
}
