import SwiftUI
import Clarity

struct ConnectionRoutesView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  @ObservedObject var resolver: ConnectionRouteResolver
  @State private var editMode = EditMode.inactive
  @State private var editor: RouteEditorSelection?
  @State private var deleting: ConnectionRoute?
  @State private var reauthenticating: ConnectionRoute?
  @State private var failure: String?
  private var computer: BackendConnection { resolver.computer }

  var body: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 14) {
          Label(computer.name, systemImage: "laptopcomputer").font(.title3.weight(.semibold))
          HStack(spacing: 6) {
            Circle().fill(resolver.checkingRouteID != nil ? .orange : resolver.activeRouteID != nil ? .green : .red)
              .frame(width: 6, height: 6)
            Text(status).font(.caption).foregroundColor(.secondary)
          }
          Text(currentName).font(.title2.weight(.semibold))
          if let route = resolver.currentRoute {
            HStack {
              Text(route.url).font(.caption).textSelection(.enabled).clarityMask()
              Spacer()
              if let latency = resolver.latency { Text("\(latency) ms").font(.caption.monospacedDigit()) }
            }.foregroundColor(.secondary)
          }
          Button {
            Task { await reconnect() }
          } label: {
            Label(computer.automatic ? "重新选择线路" : "重新连接", systemImage: "arrow.clockwise")
              .frame(maxWidth: .infinity)
          }.disabled(resolver.checkingRouteID != nil)
            .accessibilityIdentifier("connection-routes-retry")
        }.padding(.vertical, 8)
      }
      Section {
        Picker("连接方式", selection: Binding(get: { computer.automatic }, set: setAutomatic)) {
          Text("自动选择").tag(true)
          Text("手动指定").tag(false)
        }.pickerStyle(.segmented).accessibilityIdentifier("connection-routes-mode")
      } footer: {
        Text(computer.automatic ? "按线路顺序连接，断开后自动尝试其他线路。连接正常时保持当前线路。" : "仅使用指定线路，无法连接时不会自动切换。")
      }
      Section {
        ForEach(computer.routes) { route in
          routeRow(route)
        }.onMove { source, destination in
          mutate { $0.routes.move(fromOffsets: source, toOffset: destination) }
        }
        Button { editor = RouteEditorSelection(route: nil) } label: {
          Label("添加线路", systemImage: "plus.circle")
        }.accessibilityIdentifier("connection-routes-add")
      } header: {
        HStack {
          Text(computer.automatic ? "线路优先级" : "选择线路")
          Spacer()
          Button(editMode == .active ? "完成" : "编辑") { editMode = editMode == .active ? .inactive : .active }
        }
      } footer: {
        if computer.routes.isEmpty { Text("添加这台电脑的连接地址。电脑登录与未发送草稿会保留。") }
        else if editMode == .active { Text("排序在下次选择线路时生效。") }
      }
      if resolver.needsUpgrade {
        Section { Text("电脑端需升级后才能使用多线路，原有线路仍可使用。").foregroundColor(.secondary) }
      }
      if let failure { Section { Text(failure).foregroundColor(.red) } }
    }
    .listStyle(.insetGrouped).environment(\.editMode, $editMode)
    .navigationTitle("连接线路").navigationBarTitleDisplayMode(.large)
    .sheet(item: $editor) { selection in
      ConnectionRouteEditor(store: store, computerID: computer.id, route: selection.route)
    }
    .confirmationDialog("重新确认这台电脑？", isPresented: Binding(get: { reauthenticating != nil }, set: { if !$0 { reauthenticating = nil } }), titleVisibility: .visible) {
      if let route = reauthenticating {
        Button("前往重新登录") {
          Task { await session.prepareRelogin(url: route.url); dismiss() }
        }
      }
      Button("取消", role: .cancel) { reauthenticating = nil }
    } message: { Text("请确认该地址属于这台电脑。重新登录成功后将更新电脑身份；现有草稿会保留。") }
    .confirmationDialog("删除线路？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      if let deleting {
        Button("删除 \(deleting.name)", role: .destructive) {
          mutate { value in
            value.routes.removeAll { $0.id == deleting.id }
            if value.fixedRouteID == deleting.id { value.fixedRouteID = nil }
          }
          self.deleting = nil
        }
      }
      Button("取消", role: .cancel) { deleting = nil }
    } message: {
      Text(deleting?.id == resolver.activeRouteID ? "当前连接会断开。电脑上的项目、终端和本机草稿会保留。" : "只移除此连接地址，电脑上的项目和终端会保留。")
    }
  }

  private var status: String {
    if let id = resolver.checkingRouteID, let index = computer.routes.firstIndex(where: { $0.id == id }) {
      return "正在连接 · \(index + 1)/\(computer.routes.count)"
    }
    return resolver.activeRouteID != nil ? "已连接" : computer.automatic ? "未连接" : computer.fixedRouteID == nil ? "请选择线路" : "固定线路无法连接"
  }
  private var currentName: String {
    let id = resolver.checkingRouteID ?? resolver.activeRouteID ?? computer.fixedRouteID
    return computer.routes.first { $0.id == id }?.name ?? (computer.routes.isEmpty ? "尚未添加线路" : "没有可用线路")
  }
  private func routeRow(_ route: ConnectionRoute) -> some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text("\((computer.routes.firstIndex(where: { $0.id == route.id }) ?? 0) + 1)")
            .font(.caption.monospacedDigit()).foregroundColor(.secondary)
          Text(route.name).font(.body.weight(.medium)).clarityMask()
        }
        Text(route.url).font(.caption).foregroundColor(.secondary).lineLimit(2).clarityMask()
        Text(resolver.statuses[route.id] ?? "尚未检测").font(.caption2)
          .foregroundColor(resolver.activeRouteID == route.id ? .green : .secondary)
      }
      Spacer(minLength: 4)
      if !computer.automatic {
        Button { pin(route) } label: {
          Image(systemName: computer.fixedRouteID == route.id ? "checkmark.circle.fill" : "circle")
        }.buttonStyle(.borderless).accessibilityLabel("固定使用 \(route.name)")
      }
      Menu {
        Button("固定使用此线路") { pin(route) }
        Button("编辑线路") { editor = RouteEditorSelection(route: route) }
        if session.connection?.id == computer.id {
          Button("重新登录此地址") { reauthenticating = route }
        }
        Button("上移") { move(route, by: -1) }
          .disabled(computer.routes.first?.id == route.id)
        Button("下移") { move(route, by: 1) }
          .disabled(computer.routes.last?.id == route.id)
        Button("删除线路", role: .destructive) { deleting = route }
      } label: { Image(systemName: "ellipsis").frame(width: 32, height: 40) }
        .accessibilityLabel("管理 \(route.name)")
    }.padding(.vertical, 5)
      .listRowBackground(resolver.activeRouteID == route.id ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemGroupedBackground))
  }
  private func mutate(_ change: (inout BackendConnection) -> Void) {
    do { var next = computer; change(&next); try store.update(next); failure = nil }
    catch { failure = displayError(error) }
  }
  private func setAutomatic(_ value: Bool) {
    mutate { $0.automatic = value; $0.fixedRouteID = value ? nil : resolver.activeRouteID }
  }
  private func pin(_ route: ConnectionRoute) {
    mutate { $0.automatic = false; $0.fixedRouteID = route.id }
  }
  private func move(_ route: ConnectionRoute, by offset: Int) {
    guard let index = computer.routes.firstIndex(where: { $0.id == route.id }), computer.routes.indices.contains(index + offset) else { return }
    mutate { $0.routes.swapAt(index, index + offset) }
  }
  private func reconnect() async {
    failure = nil
    if session.connection?.id == computer.id { await session.reconnectRoutes() }
    else {
      do { _ = try await resolver.resolve(force: true) }
      catch { failure = displayError(error) }
    }
  }
}
private struct RouteEditorSelection: Identifiable {
  let id = UUID()
  let route: ConnectionRoute?
}
