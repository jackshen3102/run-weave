import Clarity
import SwiftUI
struct BrowseView: View {
  @ObservedObject var model: BrowseModel
  @State private var search = false; @State private var dates = false; @State private var statuses = false
  @State private var dateFrom = Date(); @State private var dateTo = Date()
  private var covered: Set<String> { Set(model.digests.filter { $0.state == "current" }.flatMap { $0.entryRefs.map(\.id) }) }
  var body: some View {
    Group {
      if !model.supported { EmptyState(title: "需要升级随记服务", detail: "服务启用浏览能力后，可在这里保存和查看浏览内容。") }
      else { feed }
    }.navigationTitle("浏览").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button { search.toggle() } label: { Image(systemName:"magnifyingglass") }.accessibilityLabel("搜索浏览")
          Button { dates = true } label: { Image(systemName:"calendar") }.accessibilityLabel("筛选日期")
          Menu {
            Menu("内容类型") {
              Button("全部类型") { model.type = "" }
              ForEach(["article","answer","image","text","link","chat-fragment","app-usage"], id:\.self) { value in Button(browseType(value)) { model.type = value } }
            }
            NavigationLink("待发送") { MaterialQueueView(session:model.session) }
            Button("采集状态与连接设置") { statuses = true }
            NavigationLink("浏览回收站") { BrowseTrashView(model:model) }
          } label: { Image(systemName:"ellipsis.circle") }.accessibilityLabel("浏览更多")
        }
      }.task(id:model.filterKey) { await model.load() }
      .sheet(isPresented:$model.editor) { BrowseEditor(model:model) }
      .sheet(isPresented:$dates) {
        NavigationStack { Form {
          DatePicker("从", selection:$dateFrom, in:...dateTo, displayedComponents:.date)
          DatePicker("至", selection:$dateTo, in:dateFrom...Date(), displayedComponents:.date)
          Button("应用日期") { model.from = MaterialInput.day(dateFrom); model.to = MaterialInput.day(dateTo); dates = false }
          Button("全部日期") { model.from = ""; model.to = ""; dates = false }
        }.environment(\.timeZone,TimeZone(identifier:"Asia/Shanghai")!).navigationTitle("浏览日期").toolbar { Button("关闭") { dates = false } } }
      }
      .sheet(isPresented:$statuses) { NavigationStack { BrowseConnectionsView(model:model).toolbar { Button("关闭") { statuses = false } } } }
  }
  private var feed: some View {
    ScrollView {
      LazyVStack(alignment:.leading,spacing:14) {
        if search { TextField("搜索已保存的标题、正文和摘要",text:$model.query).textFieldStyle(.roundedBorder).accessibilityIdentifier("browse-search") }
        ScrollView(.horizontal) {
          HStack { Button("全部") { model.source = "" }.buttonStyle(.bordered)
            ForEach(model.sources, id:\.provider) { source in Button(source.displayName) { model.source = source.provider }.buttonStyle(.bordered).tint(model.source == source.provider ? SuijiTheme.green : .secondary) }
          }
        }
        if !model.from.isEmpty || !model.type.isEmpty || !model.query.isEmpty {
          Button("清除筛选：\(model.from) \(model.to) \(browseType(model.type)) \(model.query)") { model.from = ""; model.to = ""; model.type = ""; model.query = "" }.font(.caption)
        }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange); Button("重新读取") { Task { await model.load() } } }
        if model.loading && model.items.isEmpty { ProgressView("正在读取浏览") }
        if !model.loading && model.items.isEmpty { EmptyState(title:"没有浏览内容",detail:"点击加号保存文字、链接或照片。") }
        ForEach(model.counts, id:\.date) { day in
          Text("\(day.date) · \(day.count) 条").font(.headline)
          ForEach(model.digests.filter { $0.date == day.date }) { digest in
            NavigationLink { BrowseDigestView(model:model,digest:digest) } label: {
              VStack(alignment:.leading,spacing:8) { Text(digest.title).font(.headline); Text(digest.state == "current" ? "阅读回顾" : "阅读回顾 · 待更新").font(.caption); Text(digest.body).lineLimit(4) }.padding().frame(maxWidth:.infinity,alignment:.leading).background(SuijiTheme.surface,in:RoundedRectangle(cornerRadius:16))
            }.buttonStyle(.plain)
          }
          ForEach(model.items.filter { $0.browseDate == day.date && !covered.contains($0.id) }) { entry in
            NavigationLink { BrowseDetailView(model:model,original:entry) } label: { BrowseCard(model:model,entry:entry) }.buttonStyle(.plain)
          }
        }
        if let cursor = model.nextCursor { Button("加载更多") { Task { await model.load(more:true) } }.id(cursor) }
      }.padding(20).padding(.bottom,80)
    }.background(SuijiTheme.background).refreshable { await model.load() }.clarityMask()
      .overlay(alignment:.bottomTrailing) { CaptureButton { model.editor = true }.padding(20) }
  }
}
func browseType(_ type:String) -> String {
  ["article":"文章","answer":"回答","image":"图片","text":"文字","link":"链接","chat-fragment":"聊天片段","app-usage":"App 使用时长"][type] ?? (type.isEmpty ? "" : "其他内容")
}
struct BrowseCard: View {
  @ObservedObject var model: BrowseModel; let entry: BrowseEntry
  var body: some View {
    VStack(alignment:.leading,spacing:10) {
      HStack { Text(entry.source.displayName + (entry.source.displayName == browseType(entry.contentType) ? "" : " · " + browseType(entry.contentType))); Spacer(); Text(entry.contentType == "app-usage" ? "按日统计" : entry.occurredAt == nil ? "保存于" : "浏览过") }.font(.caption).foregroundStyle(.secondary)
      Text(entry.title.isEmpty ? "保存的内容" : entry.title).font(.headline)
      if let image = entry.attachments.first(where: { $0.kind == "image" }) { BrowseThumbnail(model:model,attachment:image) }
      Text(entry.excerpt ?? entry.body ?? "").lineLimit(4)
      if entry.contentState.state != "available" { Text("正文不可用：" + browseReason(entry.contentState.reason)).font(.caption).foregroundStyle(.secondary) }
      Text(entry.contentType == "app-usage" ? "统计日期：" + entry.browseDate : browseTime(entry.occurredAt ?? entry.capturedAt)).font(.caption2).foregroundStyle(.secondary)
    }.padding(16).frame(maxWidth:.infinity,alignment:.leading).background(SuijiTheme.surface,in:RoundedRectangle(cornerRadius:16))
  }
}
struct BrowseThumbnail: View {
  @ObservedObject var model: BrowseModel; let attachment: Attachment
  @State private var image: UIImage?
  var body: some View {
    Group { if let image { Image(uiImage:image).resizable().scaledToFit().frame(maxHeight:180) } else { Label("图片",systemImage:"photo") } }
      .task(id:attachment.id) {
        guard let client = model.session.client else { return }
        if let bytes = try? await client.bytes(path:"api/suiji/v1/browse/attachments/" + attachment.id + "/content"), model.session.isCurrent(client) { image = UIImage(data:bytes) }
      }
  }
}
struct BrowseConnectionsView: View {
  @ObservedObject var model: BrowseModel
  var body: some View {
    List {
      Text("仅显示已绑定的采集连接。停用连接不会删除已保存浏览；登录与绑定在采集所在 Mac 完成。").font(.footnote)
      ForEach(model.connections) { item in
        VStack(alignment:.leading) {
          Text((["zhihu":"知乎", "app-usage":"App 使用时长"][item.provider] ?? item.provider) + " · " + (item.state == "active" ? "已启用" : "已停用"))
          Text(item.provider == "app-usage" ? item.machine + " · 本机归档" : item.machine + " / " + item.profile + " / " + item.group)
          if item.provider != "app-usage" { Text(item.lastSuccessAt.map(browseTime) ?? "尚未成功采集").font(.caption) }
          if let coverage = item.latestCoverage {
            Text(item.provider == "app-usage" ? (coverage.errors.contains("observed-only") ? "最近同步仅覆盖已观察记录" : "最近同步未完成") : coverage.state == "complete" ? "最近声明范围读取完成" : "最近采集范围不完整")
            ForEach(coverage.errors,id:\.self) { error in Text(error == "observed-only" ? "可能延迟或缺失，不代表全天完整使用情况" : browseFailure(error)).font(.caption).foregroundStyle(.orange) }
          } else if item.provider == "app-usage" { Text("尚未同步归档").font(.caption) }
        }
      }
      if model.connections.isEmpty { Text("尚未配置自动采集") }
      if !model.message.isEmpty { Text(model.message) }
    }.clarityMask().navigationTitle("采集状态与连接").task { await model.loadConnections() }
  }
}
struct BrowseTrashView: View {
  @StateObject private var model: BrowseModel
  init(model:BrowseModel) { _model = StateObject(wrappedValue:BrowseModel(session:model.session)) }
  var body: some View {
    List { ForEach(model.items) { entry in NavigationLink { BrowseDetailView(model:model,original:entry) } label: { Text(entry.title) } }; if let cursor = model.nextCursor { Button("加载更多") { Task { await model.load(more:true,trash:true) } }.id(cursor) } }
      .navigationTitle("浏览回收站").task { await model.load(trash:true) }
  }
}

func browseReason(_ reason:String?) -> String {
  switch reason {
  case "unsupported-content-type": return "此类型暂仅保存标题与浏览时间"
  case "paid-content-limited": return "仅取得公开部分"
  case "forbidden": return "来源限制访问"
  case "not-found": return "来源内容不存在"
  default: return "文字正文暂不可用"
  }
}

func browseFailure(_ code:String) -> String {
  switch code { case "needs-login": return "需要在采集 Mac 重新登录"; case "identity-changed": return "来源账号已变化，未提交内容"; case "rate-limited": return "来源请求受到限流"; case "timeout": return "来源请求超时"; default: return "采集暂不可用，请检查采集所在 Mac" }
}

func browseTime(_ value:String) -> String {
  let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
  var date = parser.date(from:value)
  if date == nil { parser.formatOptions = [.withInternetDateTime]; date = parser.date(from:value) }
  guard let date else { return value }
  let format = DateFormatter(); format.locale = Locale(identifier:"zh_CN"); format.timeZone = TimeZone(identifier:"Asia/Shanghai"); format.dateFormat = "yyyy-MM-dd HH:mm"
  return format.string(from:date)
}
