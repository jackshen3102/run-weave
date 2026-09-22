import SwiftUI

struct KnowledgeInboxRow: View {
  let item: InboxItem
  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack {
        Text("\(item.projectName) · \(item.sourceLabel)").font(.caption).foregroundColor(.secondary)
        Spacer()
        if item.hasUpdate { Text("有更新").font(.caption).foregroundColor(.orange) }
        if item.processedAt != nil { Image(systemName: "checkmark.circle").foregroundColor(.mint) }
      }
      Text(item.title).font(.headline).lineLimit(2)
      if !item.excerpt.isEmpty { Text(item.excerpt).font(.subheadline).lineLimit(3).foregroundColor(.secondary) }
      Text(item.updatedLabel).font(.caption2).foregroundColor(.secondary)
    }.padding(.vertical, 6)
  }
}
struct KnowledgeInboxPreview: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: KnowledgeInboxModel
  var body: some View {
    Section {
      if let failure = model.failure { Text(failure).font(.caption).foregroundColor(.orange) }
      if model.preview?.sourceStatus.status == "partial" { Text("部分来源暂不可用，列表不完整").font(.caption).foregroundColor(.orange) }
      ForEach(model.preview?.items ?? []) { item in
        NavigationLink {
          KnowledgeInboxDetail(session: session, model: model, item: item)
        } label: { KnowledgeInboxRow(item: item) }
      }
      if model.preview == nil && model.failure == nil { ProgressView("正在读取成果…") }
      if model.preview?.items.isEmpty == true && model.failure == nil && model.preview?.sourceStatus.status == "ok" {
        Text("当前没有待处理成果").foregroundColor(.secondary)
      }
      NavigationLink("查看全部") { KnowledgeInboxList(session: session, model: model) }
    } header: { Label("自进化", systemImage: "sparkles") }
    .task(id: "\(session.generation):\(session.foreground)") {
      if session.foreground { await model.poll("preview") }
    }
  }
}
struct KnowledgeInboxList: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: KnowledgeInboxModel
  var body: some View {
    List {
      Section {
        Picker("成果来源", selection: $model.source) {
          Text("自进化").tag("evolution")
          Text("经验").tag("experience")
          Text("全部").tag("")
        }.pickerStyle(.segmented)
          .accessibilityIdentifier("knowledge-inbox-source")
        Picker("处理状态", selection: $model.state) {
          Text("待处理").tag("pending")
          Text("已处理").tag("processed")
        }.pickerStyle(.segmented)
        Picker("项目", selection: $model.repositoryID) {
          Text("全部项目").tag("")
          ForEach(model.repositories) { Text($0.displayName).tag($0.id) }
        }
      }
      if let failure = model.failure { Text(failure).foregroundColor(.orange) }
      if model.partial { Text("部分来源暂不可用，列表不完整").foregroundColor(.orange) }
      ForEach(model.items) { item in
        NavigationLink { KnowledgeInboxDetail(session: session, model: model, item: item) }
          label: { KnowledgeInboxRow(item: item) }
      }
      if model.loading { ProgressView() }
      if !model.loading && model.items.isEmpty && model.failure == nil && !model.partial {
        Text(model.state == "pending" ? "当前筛选下没有待处理成果" : "当前筛选下暂无处理历史").foregroundColor(.secondary)
      }
      if model.nextCursor != nil { Button("加载更多") { Task { await model.refreshList(more: true) } }.disabled(model.loading) }
    }
    .navigationTitle("自进化")
    .refreshable { await model.refreshList() }
    .task(id: "\(session.generation):\(session.foreground):\(model.state):\(model.source):\(model.repositoryID)") {
      if session.foreground { await model.poll("list") }
    }
  }
}
struct KnowledgeInboxDetail: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: KnowledgeInboxModel
  let item: InboxItem
  @State private var initialized = false
  var body: some View {
    let value = model.detail?.id == item.id ? model.detail! : item
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        Text("\(value.projectName) · \(value.sourceLabel)").font(.caption).foregroundColor(.secondary)
        Text(value.title).font(.title2.bold())
        Text("\(value.validationLabel)\n\(value.updatedLabel)").font(.caption).foregroundColor(.secondary)
        if value.availability != "available" { Text("已失效 / 暂不可用").foregroundColor(.orange) }
        if value.currentContentVersion != nil { Text("这是处理时的正文，当前已有新版本。") .foregroundColor(.orange) }
        if let failure = model.failure { Text(failure).foregroundColor(.orange) }
        if let failure = model.detailFailure { Text(failure).foregroundColor(.orange) }
        if let failure = model.actionFailure { Text(failure).foregroundColor(.red) }
        if !value.statement.isEmpty { Text(value.statement).textSelection(.enabled) }
        if !value.applicability.isEmpty { section("适用条件", [value.applicability]) }
        section("建议", value.guidance)
        section("步骤", value.actions)
        section("避坑", value.avoid)
        section("验证说明", value.verification)
      }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
    }
    .navigationTitle("成果详情").navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) {
      Button {
        Task { await model.change() }
      } label: {
        Label(model.writing ? "正在保存…" : value.currentContentVersion != nil ? "查看当前版本" : value.processedAt == nil ? "已处理" : "恢复待处理",
          systemImage: value.processedAt == nil ? "checkmark.circle" : "arrow.uturn.backward")
          .frame(maxWidth: .infinity).padding(.vertical, 8)
      }.buttonStyle(.borderedProminent).tint(.mint)
        .disabled(!model.canWrite || !session.foreground || session.health.status == .offline || value.availability != "available")
        .padding().background(.regularMaterial)
    }
    .refreshable { await model.refreshDetail() }
    .task(id: "\(session.generation):\(session.foreground):\(item.id)") {
      if session.foreground {
        if !initialized { model.select(item); initialized = true }
        await model.poll("detail")
      }
    }
  }
  @ViewBuilder private func section(_ title: String, _ lines: [String]?) -> some View {
    if let lines, !lines.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Text(title).font(.headline)
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in Text(line).textSelection(.enabled) }
      }
    }
  }
}
