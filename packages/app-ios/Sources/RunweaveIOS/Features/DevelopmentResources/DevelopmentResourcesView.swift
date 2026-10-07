import Clarity
import SwiftUI

struct DevelopmentResourcesView: View {
  @ObservedObject var session: AppSession
  @StateObject private var model: DevelopmentResourcesModel
  @State private var group = Group.desktop
  @State private var filter = Filter.all
  @State private var expanded = Set<String>()
  private enum Group: String, CaseIterable { case desktop = "桌面", simulators = "模拟器" }
  private enum Filter: String, CaseIterable { case all = "全部", busy = "占用中", attention = "待检查" }

  init(session: AppSession) {
    self.session = session
    _model = StateObject(wrappedValue: DevelopmentResourcesModel(session: session))
  }
  private var selectedGroup: DevelopmentResourceGroup? {
    group == .desktop ? model.data?.desktop : model.data?.simulators
  }
  private func matches(_ resource: DevelopmentResource) -> Bool {
    switch filter {
    case .all: return true
    case .busy: return resource.state == "busy" || resource.operation?.state == "running"
    case .attention: return resource.isAttention
    }
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        connection
        if let status = model.statusMessage { statusCard(status, warning: true) }
        if let notice = model.notice { statusCard(notice.text, warning: notice.warning) }
        if model.loading && model.data == nil {
          ProgressView("正在读取资源…").frame(maxWidth: .infinity).padding(24)
        }
        HStack(spacing: 10) {
          summary("桌面测试", icon: "desktopcomputer", value: model.data?.desktop, target: .desktop)
          summary("模拟器测试", icon: "iphone", value: model.data?.simulators, target: .simulators)
        }
        Picker("资源类型", selection: $group) {
          ForEach(Group.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).accessibilityIdentifier("development-resource-groups")
        HStack(spacing: 8) {
          ForEach(Filter.allCases, id: \.self) { item in
            Button { filter = item } label: {
              Text(item.rawValue).font(.caption).padding(.horizontal, 14).frame(minHeight: 44)
                .foregroundColor(filter == item ? .blue : .secondary)
                .background(filter == item ? Color.blue.opacity(0.15) : Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(Capsule())
            }.buttonStyle(.plain).accessibilityAddTraits(filter == item ? .isSelected : [])
          }
        }
        if let value = selectedGroup {
          if let reason = value.reason { statusCard(reason, warning: true) }
          resourceList(value.resources)
          if group == .desktop, let sessions = value.sessions, !sessions.filter(matches).isEmpty {
            Text("其他桌面会话").font(.caption).foregroundColor(.secondary)
            resourceList(sessions)
          }
          if value.resources.filter(matches).isEmpty,
            (group != .desktop || (value.sessions ?? []).filter(matches).isEmpty) {
            Text(value.sourceState == "ready" ? "没有符合条件的资源" : "暂时无法读取这类资源")
              .font(.subheadline).foregroundColor(.secondary).frame(maxWidth: .infinity).padding(24)
          }
        } else if !model.loading && model.statusMessage == nil {
          Text("暂无资源数据，点击刷新重试").font(.subheadline).foregroundColor(.secondary)
        }
      }.padding(16)
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("开发资源").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        Button { Task { await model.refresh() } } label: {
          if model.loading { ProgressView() } else { Image(systemName: "arrow.clockwise") }
        }.accessibilityLabel("刷新开发资源").accessibilityIdentifier("development-resources-refresh")
          .disabled(model.loading || model.writing || !model.current || !session.foreground || session.health.status != .online)
      }
    }
    .task { await model.enter() }
    .onDisappear { model.leave() }
    .onChange(of: session.health.serviceInstanceID) { _ in model.invalidateConfirmation() }
    .onChange(of: session.health.status) { _ in if session.health.status != .online { model.invalidateConfirmation() } }
    .onChange(of: session.foreground) { active in if !active { model.invalidateConfirmation() } }
    .sheet(item: $model.confirmation) { pending in
      if #available(iOS 16.0, *) {
        confirmation(pending).presentationDetents([.height(610), .large]).presentationDragIndicator(.visible)
      } else { confirmation(pending) }
    }
    .clarityMask().mobileAnalyticsScreen(.developmentResources)
  }
  private var connection: some View {
    HStack(alignment: .firstTextBaseline) {
      Label(model.data?.hostName ?? session.connection?.name ?? "当前电脑", systemImage: "desktopcomputer")
        .font(.caption).lineLimit(1)
      Spacer(minLength: 8)
      if let date = developmentResourceDate(model.data?.observedAt) {
        Text("更新于 \(date.formatted(date: .omitted, time: .standard))").font(.caption2).foregroundColor(.secondary)
      }
    }
  }
  private func summary(_ title: String, icon: String, value: DevelopmentResourceGroup?, target: Group) -> some View {
    Button { group = target } label: {
      VStack(alignment: .leading, spacing: 10) {
        Label(title, systemImage: icon).font(.subheadline)
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          Text(value?.counts.occupied.map(String.init) ?? "—").font(.system(size: 30, weight: .semibold))
          Text("/ \(value?.counts.total.map(String.init) ?? "—") 已占用").font(.caption2).foregroundColor(.secondary)
        }
        HStack(spacing: 4) {
          Text("\(value?.counts.free.map(String.init) ?? "—") 空闲")
          if let attention = value?.counts.attention, attention > 0 { Text("· \(attention) 待检查").foregroundColor(.orange) }
        }.font(.caption2).foregroundColor(.secondary)
      }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground)).cornerRadius(13)
    }.buttonStyle(.plain)
  }
  @ViewBuilder private func resourceList(_ values: [DevelopmentResource]) -> some View {
    ForEach(values.filter(matches)) { resource in
      DevelopmentResourceCard(resource: resource, observedAt: model.data?.observedAt,
        expanded: expanded.contains(resource.id), canOperate: model.canOperate,
        releasing: model.releasingID == resource.id,
        toggle: { if expanded.contains(resource.id) { expanded.remove(resource.id) } else { expanded.insert(resource.id) } },
        release: { model.select(resource) })
    }
  }
  private func statusCard(_ text: String, warning: Bool) -> some View {
    Text(text).font(.caption).foregroundColor(warning ? .orange : .green)
      .frame(maxWidth: .infinity, alignment: .leading).padding(12)
      .background((warning ? Color.orange : Color.green).opacity(0.1)).cornerRadius(10)
      .accessibilityIdentifier("development-resources-status")
  }
  private func confirmation(_ pending: DevelopmentResourcesModel.Confirmation) -> some View {
    DevelopmentResourceConfirmation(pending: pending,
      cancel: { model.confirmation = nil },
      confirm: { Task { await model.confirm(pending) } })
  }
}
