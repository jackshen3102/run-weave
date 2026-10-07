import Clarity
import SwiftUI

struct HomeView: View {
  private enum AttentionPriority: Int {
    case unread
    case active
    case pinned
    case recentlyRead
  }

  @ObservedObject var session: AppSession
  @ObservedObject private var attentionRetention: AttentionRetentionStore
  @EnvironmentObject private var remoteDesktop: RemoteDesktopCoordinator
  @StateObject private var branchStatuses = HomeBranchStatusModel()
  @State private var query = ""
  @State private var expanded = Set<String>()
  @State private var newProject = false
  @State private var deleting: HomeTerminal?
  @State private var showingDiagnostics = false
  @State private var renaming: HomeTerminal?
  @State private var initializedGeneration: Int?
  @State private var visibleConversationCounts: [String: Int] = [:]

  init(session: AppSession) {
    self.session = session
    self.attentionRetention = session.attentionRetention
  }

  var groups: [HomeGroup] { session.overview?.groups(matching: query) ?? [] }

  private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var attention: [HomeTerminal] {
    let online = session.health.status == .online
    return groups.flatMap(\.sessions).filter {
      $0.hasUnreadCompletion || (online && $0.isAgentActive) || $0.pinnedAt != nil
        || (attentionRetention.retainedUntil[$0.id].map { $0 > Date() } ?? false)
    }.sorted { left, right in
      let leftPriority = attentionPriority(left, online: online)
      let rightPriority = attentionPriority(right, online: online)
      if leftPriority != rightPriority { return leftPriority.rawValue < rightPriority.rawValue }
      if leftPriority == .pinned, left.pinnedAt != right.pinnedAt {
        return (left.pinnedAt ?? "") > (right.pinnedAt ?? "")
      }
      if leftPriority == .recentlyRead,
        attentionRetention.retainedUntil[left.id] != attentionRetention.retainedUntil[right.id] {
        return (attentionRetention.retainedUntil[left.id] ?? .distantPast)
          > (attentionRetention.retainedUntil[right.id] ?? .distantPast)
      }
      if left.lastActivityAt != right.lastActivityAt {
        return left.lastActivityAt > right.lastActivityAt
      }
      return left.id < right.id
    }
  }

  private func attentionPriority(
    _ terminal: HomeTerminal, online: Bool
  ) -> AttentionPriority {
    if terminal.hasUnreadCompletion { return .unread }
    if online && terminal.isAgentActive { return .active }
    if terminal.pinnedAt != nil { return .pinned }
    return .recentlyRead
  }

  private func initializeExpansion() {
    guard session.overview != nil, initializedGeneration != session.generation else { return }
    expanded = Set((session.overview?.groups(matching: "") ?? []).prefix(4).map(\.id))
    initializedGeneration = session.generation
  }

  private func row(_ terminal: HomeTerminal, projectName: String? = nil) -> some View {
    HomeTerminalRow(session: session, terminal: terminal, projectName: projectName,
      branchStatus: projectName == nil ? nil : branchStatuses.status(for: terminal, generation: session.generation, online: session.health.status == .online),
      rename: { renaming = terminal }, delete: { deleting = terminal })
      .onAppear { visibleConversationCounts[terminal.id, default: 0] += 1 }
      .onDisappear {
        let count = visibleConversationCounts[terminal.id, default: 0] - 1
        if count > 0 { visibleConversationCounts[terminal.id] = count }
        else { visibleConversationCounts.removeValue(forKey: terminal.id) }
      }
  }

  private var branchRefreshKey: [String] {
    [String(session.generation), String(session.foreground), String(session.authenticated),
      session.health.status.rawValue, session.terminal?.id ?? ""]
      + attention.map { "\($0.id):\($0.cwd)" }.sorted()
  }

  private var conversationRefreshKey: [String] {
    [String(session.generation), String(session.foreground), String(session.authenticated),
      session.health.status.rawValue, session.terminal?.id ?? ""]
      + (session.overview?.sessions.map { "\($0.id):\($0.conversationKey ?? "")" }.sorted() ?? [])
      + visibleConversationCounts.keys.sorted()
  }

  private func refreshHome() async {
    await session.refresh()
    await session.knowledgeInbox.refreshPreview()
    await branchStatuses.refresh(session: session, terminals: attention, force: true)
  }

  var body: some View {
    List {
      if session.health.status == .offline {
        Section { Text("本地电脑暂时不可用，列表会保留最近一次加载的数据。").foregroundColor(.orange) }
      }
      if let error = session.error {
        Section { Text(error).foregroundColor(.red) }
      }
      if session.loading && session.overview == nil { ProgressView() }
      if !session.loading, session.overview != nil, searching, groups.isEmpty {
        Text("没有找到匹配的项目或终端")
      } else if !session.loading, session.overview?.projects.isEmpty == true { Text("暂无项目") }
      if !attention.isEmpty {
        Section("关注") {
          ForEach(attention) { terminal in
            row(terminal, projectName: session.overview?.projects.first {
              $0.id == HomeOverview.parentProjectID(terminal.projectId)
            }?.name)
          }
        }
      }
      KnowledgeInboxPreview(session: session, model: session.knowledgeInbox)
      ForEach(groups) { group in
        Section {
          if searching || expanded.contains(group.id) {
            if group.sessions.isEmpty { Text("暂无终端").foregroundColor(.secondary) }
            ForEach(group.sessions) { terminal in
              row(terminal)
            }
          }
        } header: {
          HStack {
            Button {
              guard !searching else { return }
              if expanded.contains(group.id) {
                expanded.remove(group.id)
              } else {
                expanded.insert(group.id)
              }
            } label: {
              HStack {
                Image(systemName: (searching || expanded.contains(group.id)) ? "chevron.down" : "chevron.right")
                VStack(alignment: .leading) {
                  Text(group.project.name)
                  Text(group.project.path ?? "No path").font(.caption2).lineLimit(1)
                }
                Spacer()
                TerminalGroupStatus(terminals: group.sessions, bells: session.bellMarkers)
                Text("\(group.terminalCount)")
              }
            }.accessibilityLabel(searching ? group.project.name : "展开或收起 \(group.project.name)")
            Button {
              Task { await session.createTerminal(projectID: group.id) }
            } label: {
              Image(systemName: "plus")
            }
            .accessibilityLabel("在 \(group.project.name) 创建终端").disabled(!session.canWrite)
          }.textCase(nil)
        }
      }
    }
    .searchable(text: $query, prompt: "Search projects and terminals")
    .refreshable { await refreshHome() }
    .task(id: conversationRefreshKey) {
      guard session.foreground, session.authenticated, session.health.status == .online,
        session.terminal == nil else { return }
      while !Task.isCancelled {
        await session.refreshHomeConversationPreviews(ids: session.overview?.sessions.compactMap {
          $0.conversationKey == nil || visibleConversationCounts[$0.id] == nil ? nil : $0.id
        } ?? [])
        do { try await Task.sleep(nanoseconds: 5_000_000_000) }
        catch { return }
      }
    }
    .task(id: branchRefreshKey) {
      guard session.foreground, session.authenticated, session.health.status == .online,
        session.terminal == nil else { return }
      var recheck = true
      while !Task.isCancelled {
        await branchStatuses.refresh(session: session, terminals: attention, recheck: recheck)
        recheck = false
        do { try await Task.sleep(nanoseconds: 30_000_000_000) }
        catch { return }
      }
    }
    .onChange(of: session.overview?.projects.map(\.id)) { _ in initializeExpansion() }
    .onChange(of: session.generation) { _ in
      expanded.removeAll()
      initializedGeneration = nil
      query = ""
      renaming = nil
      deleting = nil
      initializeExpansion()
    }
    .onAppear { initializeExpansion() }
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        Menu {
          Button("Mac 桌面") { remoteDesktop.managingHosts = true }
            .accessibilityIdentifier("remote-desktop-hosts")
          Button("耗电监控") { session.showingEnergyMonitor = true }
          Button("定时任务") { session.showingScheduledTasks = true }
          Button("新增项目") { newProject = true }.disabled(!session.canWrite)
          Button("刷新") { Task { await refreshHome() } }
          Button("诊断") { showingDiagnostics = true }
          Button("Logout", role: .destructive) { Task { await session.logout() } }
        } label: {
          Image(systemName: "ellipsis.circle")
        }.accessibilityLabel("Home actions")
      }
    }
    .sheet(isPresented: $newProject) {
      NewProjectView(session: session) { id in
        expanded.insert(id)
        query = ""
      }.mobileAnalyticsScreen(.newProject)
    }
    .sheet(item: $renaming) { terminal in
      RenameTerminalView(session: session, terminal: terminal).mobileAnalyticsScreen(.renameTerminal)
    }
    .sheet(isPresented: $showingDiagnostics) { DiagnosticsView(session: session).mobileAnalyticsScreen(.diagnostics) }
    .confirmationDialog(
      "删除终端？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible
    ) {
      if let terminal = deleting {
        Button("删除 \(terminal.title)", role: .destructive) {
          Task { await session.deleteTerminal(terminal.id) }
          deleting = nil
        }
      }
      Button("取消", role: .cancel) { deleting = nil }
    } message: {
      Text("删除后将结束该远端终端会话。")
    }
  }
}

private struct NewProjectView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let created: (String) -> Void
  @State private var name = ""
  @State private var path = ""
  @State private var failure: String?
  @State private var busy = false

  var body: some View {
    NavigationView {
      Form {
        TextField("项目名称", text: $name).clarityMask()
        TextField("项目路径（可选）", text: $path).autocapitalization(.none).disableAutocorrection(true).clarityMask()
        if let failure { Text(failure).foregroundColor(.red) }
        Button(busy ? "创建中…" : "创建项目") {
          busy = true
          Task {
            do {
              let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
              let result = try await session.createProject(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                path: path.isEmpty ? nil : path)
              created(result.id)
              dismiss()
            } catch { failure = displayError(error) }
            busy = false
          }
        }.disabled(
          busy || !session.canWrite || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }.disabled(busy)
        .navigationTitle("新增项目").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("关闭") { dismiss() }.disabled(busy) }
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy)
  }
}
