import SwiftUI
public struct SuijiRootView: View {
  @StateObject private var session: SuijiSession
  public init(endpoint: URL? = nil) { _session = StateObject(wrappedValue: SuijiSession(endpoint: endpoint)) }
  public var body: some View {
    Group {
      if let info = session.info { CaptureHome(session: session).id(session.environment.rawValue + info.serverId + info.ownerId + session.endpoint) }
      else { ConnectionView(session: session).id(session.environment) }
    }.tint(SuijiTheme.green).task { if !session.endpoint.isEmpty { await session.connect() } }
  }
}
struct CaptureHome: View {
  @ObservedObject var session: SuijiSession
  @StateObject private var review: ReviewModel
  init(session: SuijiSession) { self.session = session; _review = StateObject(wrappedValue: ReviewModel(session: session)) }
  @State private var tab = "records"
  @State private var filter = ""
  @State private var taskStatus = "open"
  @State private var query = ""
  @State private var searchVisible = false
  @State private var searchVisibleAtDragStart = false
  @State private var refreshOnRelease = false
  @FocusState private var searchFocused: Bool
  @State private var settings = false
  private var kind: String? { tab == "tasks" ? "task" : filter.isEmpty ? nil : filter }
  private var status: String? { tab == "tasks" ? taskStatus : nil }
  private var visibleRecords: [SuijiRecord] { session.records.filter { ($0.deletedAt != nil) == (tab == "trash") && (status == nil || $0.taskStatus?.rawValue == status) } }
  private var loadKey: String { "\(tab)|\(filter)|\(taskStatus)|\(query)" }
  var body: some View {
    TabView(selection: $tab) {
      NavigationStack {
        feed.navigationTitle("随记").navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .topBarTrailing) { Button { settings = true } label: { Image(systemName: "gearshape").accessibilityLabel("连接设置") } }
        }
      }.tabItem { Label("记录", systemImage: "square.and.pencil") }.tag("records")
      NavigationStack { feed.navigationTitle("待办") }.tabItem { Label("待办", systemImage: "checklist") }.tag("tasks")
      NavigationStack { feed.navigationTitle("回收站") }.tabItem { Label("回收站", systemImage: "trash") }.tag("trash")
      NavigationStack { ReviewView(session: session, model: review) }.tabItem { Label("AI", systemImage: "sparkles") }.tag("ai")
    }.task(id: loadKey) { if tab != "ai" { await session.load(kind: kind, status: status, q: query, trash: tab == "trash", hideCompleted: tab == "records") } }
      .sheet(item: $session.editor, onDismiss: { Task { await session.load(kind: kind, status: status, q: query, trash: tab == "trash", hideCompleted: tab == "records") } }) { RecordEditorSheet(model: $0) }
      .onDisappear { review.stopWatching() }
      .sheet(isPresented: $settings) { ConnectionSettingsView(session: session) }
  }
  private var feed: some View {
    ScrollView {
      LazyVStack(spacing: 14) {
        if searchVisible { searchField }
        if tab == "tasks" { FilterBar(values: TaskStatus.allCases.map { ($0.rawValue, $0.label) }, selected: $taskStatus) }
        else { FilterBar(values: [("", "全部"), ("note", "想法"), ("task", "待办")], selected: $filter) }
        if !session.message.isEmpty { Text(session.message).foregroundStyle(.orange); Button("重新读取") { Task { await session.load(kind: kind, status: status, q: query, trash: tab == "trash", hideCompleted: tab == "records") } } }
        if session.loading && visibleRecords.isEmpty { ProgressView("正在读取") }
        else if visibleRecords.isEmpty { EmptyState(title: query.isEmpty ? (tab == "trash" ? "回收站为空" : "还没有记录") : "没有搜索结果", detail: query.isEmpty ? (tab == "trash" ? "删除的记录会保留在这里，可随时恢复。" : "点右下角加号，记下此刻的想法。") : "试试正文中的其他关键词。") }
        ForEach(visibleRecords) { record in
          RecordCard(record: record, pending: session.pendingStatuses.contains(record.id), busy: session.statusBusy.contains(record.id), onStatusChange: { target in
            Task { await session.changeRecord(record, action: .status(target)) }
          }) {
            RecordDetail(session: session, original: record, onReview: { item in
              if !review.running && !review.pending { review.scope = .record(item.id) }; tab = "ai"
            })
          }
        }
        if session.nextCursor != nil { Button(session.loading ? "读取中…" : "加载更多") { Task { await session.load(kind: kind, status: status, q: query, more: true, trash: tab == "trash", hideCompleted: tab == "records") } }.disabled(session.loading) }
      }.padding(.horizontal, 20).padding(.bottom, 90)
    }.background(SuijiTheme.background)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentOffset.y + geometry.contentInsets.top < -56
      } action: { _, pulledDown in
        if pulledDown {
          if searchVisibleAtDragStart { refreshOnRelease = true }
          else if !searchVisible { withAnimation(.easeInOut(duration: 0.2)) { searchVisible = true } }
        }
      }
      .onScrollPhaseChange { previous, phase in
        if phase == .tracking || (phase == .interacting && previous != .tracking) {
          searchVisibleAtDragStart = searchVisible; refreshOnRelease = false
        }
        if previous == .interacting && phase != .interacting && phase != .tracking && refreshOnRelease {
          refreshOnRelease = false
          if !session.loading { Task { await session.load(kind: kind, status: status, q: query, trash: tab == "trash", hideCompleted: tab == "records") } }
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .overlay(alignment: .bottomTrailing) { if tab != "trash" { CaptureButton { Task { await session.openEditor() } }.padding(20) } }
  }
  private var searchField: some View {
    HStack(spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
        TextField("搜索正文关键词", text: $query)
          .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
          .focused($searchFocused).accessibilityIdentifier("record-search")
        if !query.isEmpty {
          Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
            .accessibilityLabel("清空搜索")
        }
      }.padding(12).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      Button("取消") {
        searchFocused = false; query = ""
        withAnimation(.easeInOut(duration: 0.2)) { searchVisible = false }
      }.fixedSize()
    }.padding(.top, 8)
  }
}
