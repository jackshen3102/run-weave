import SwiftUI
public struct SuijiRootView: View {
  @StateObject private var session: SuijiSession
  public init(endpoint: URL? = nil) { _session = StateObject(wrappedValue: SuijiSession(endpoint: endpoint)) }
  public var body: some View {
    Group {
      if let info = session.info { CaptureHome(session: session).id(info.serverId + info.ownerId + session.endpoint) }
      else { ConnectionView(session: session) }
    }.tint(SuijiTheme.green).task { if !session.endpoint.isEmpty { await session.connect() } }
  }
}
struct ConnectionView: View {
  @ObservedObject var session: SuijiSession
  @State private var username = ""
  @State private var password = ""
  @State private var busy = false
  var body: some View {
    NavigationStack {
      Form {
        Section { Text("随记").font(.largeTitle.bold()); Text("随手记录，慢慢回看。独立连接你的随记云服务。").foregroundStyle(.secondary) }
        Section("云服务") {
          TextField("https://你的云服务地址", text: $session.endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).accessibilityLabel("云服务地址")
          TextField("账号", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
          SecureField("密码", text: $password).textContentType(.password)
          Button(busy ? "连接中…" : "登录") { busy = true; Task { await session.connect(username: username, password: password); password = ""; busy = false } }
          Button("恢复已有登录") { busy = true; Task { await session.connect(); busy = false } }
        }.disabled(busy)
        if !session.message.isEmpty { Section { Text(session.message).foregroundStyle(.orange) } }
      }.navigationTitle("欢迎使用随记")
    }
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
  @State private var settings = false
  private var kind: String? { tab == "tasks" ? "task" : filter.isEmpty ? nil : filter }
  private var status: String? { tab == "tasks" ? taskStatus : nil }
  private var loadKey: String { "\(tab)|\(filter)|\(taskStatus)|\(query)" }
  var body: some View {
    TabView(selection: $tab) {
      NavigationStack {
        feed.navigationTitle("随记").toolbar { Button { settings = true } label: { Image(systemName: "gearshape").accessibilityLabel("连接设置") } }
      }.tabItem { Label("记录", systemImage: "square.and.pencil") }.tag("records")
      NavigationStack { feed.navigationTitle("待办") }.tabItem { Label("待办", systemImage: "checklist") }.tag("tasks")
      NavigationStack { ReviewView(session: session, model: review) }.tabItem { Label("AI", systemImage: "sparkles") }.tag("ai")
    }.task(id: loadKey) { if tab != "ai" { await session.load(kind: kind, status: status, q: query) } }
      .sheet(item: $session.editor, onDismiss: { Task { await session.load(kind: kind, status: status, q: query) } }) { RecordEditorSheet(model: $0) }
      .onDisappear { review.stopWatching() }
      .sheet(isPresented: $settings) {
        NavigationStack { Form {
          Section("当前云服务") { Text(session.endpoint); Text("已登录独立随记账号") }
          Section { Button("退出登录 / 更换服务地址", role: .destructive) { settings = false; Task { await session.logout() } } }
        }.navigationTitle("连接设置").toolbar { Button("关闭") { settings = false } } }
      }
  }
  private var feed: some View {
    ScrollView {
      LazyVStack(spacing: 14) {
        if tab == "tasks" { FilterBar(values: TaskStatus.allCases.map { ($0.rawValue, $0.label) }, selected: $taskStatus) }
        else { FilterBar(values: [("", "全部"), ("note", "想法"), ("task", "待办")], selected: $filter) }
        if !session.message.isEmpty { Text(session.message).foregroundStyle(.orange); Button("重新读取") { Task { await session.load(kind: kind, status: status, q: query) } } }
        if session.loading && session.records.isEmpty { ProgressView("正在读取") }
        else if session.records.isEmpty { EmptyState(title: query.isEmpty ? "还没有记录" : "没有搜索结果", detail: query.isEmpty ? "点右下角加号，记下此刻的想法。" : "试试正文中的其他关键词。") }
        ForEach(session.records.filter { status == nil || $0.taskStatus?.rawValue == status }) { record in
          NavigationLink { RecordDetail(session: session, original: record, onReview: { item in
            if !review.running && !review.pending { review.scope = .record(item.id) }; tab = "ai"
          }) } label: { RecordCard(record: record, pending: session.pendingStatuses.contains(record.id)) }.buttonStyle(.plain)
        }
        if session.nextCursor != nil { Button(session.loading ? "读取中…" : "加载更多") { Task { await session.load(kind: kind, status: status, q: query, more: true) } }.disabled(session.loading) }
      }.padding(.horizontal, 20).padding(.bottom, 90)
    }.background(SuijiTheme.background).searchable(text: $query, prompt: "搜索正文关键词")
      .refreshable { await session.load(kind: kind, status: status, q: query) }
      .overlay(alignment: .bottomTrailing) { CaptureButton { Task { await session.openEditor(kind: tab == "tasks" ? .task : .note) } }.padding(20) }
  }
}
