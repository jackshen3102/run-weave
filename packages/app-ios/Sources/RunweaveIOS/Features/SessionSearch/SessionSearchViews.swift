import SwiftUI

struct SessionSearchView: View {
  @ObservedObject var session: AppSession
  @StateObject private var model = SessionSearchModel()
  @FocusState private var queryFocused: Bool
  var body: some View {
    List {
      Section("搜索范围") {
        Picker("项目", selection: $model.projectID) {
          Text("选择项目").tag("")
          ForEach((session.overview?.projects ?? []).filter { $0.path != nil }) { Text($0.name).tag($0.id) }
          Text("全部项目（此电脑）").tag("all")
        }.accessibilityIdentifier("session-search-project")
        Picker("Agent", selection: $model.provider) {
          Text("全部 Agent").tag("")
          Text("Codex").tag("codex"); Text("Pi").tag("pi"); Text("Claude").tag("claude"); Text("AGY").tag("agy")
        }
        Picker("内容", selection: $model.level) {
          Text("对话").tag("chat"); Text("对话与操作").tag("work"); Text("含工具输出").tag("full")
        }
        Toggle("包含后台、子 Agent 与审查记录", isOn: $model.others)
        TextField("关键词、文件名或错误码", text: $model.query).autocorrectionDisabled()
          .textInputAutocapitalization(.never).submitLabel(.search)
          .focused($queryFocused)
          .onSubmit { queryFocused = false; Task { await model.search(session: session) } }
          .accessibilityIdentifier("session-search-query")
        Button("搜索") { queryFocused = false; Task { await model.search(session: session) } }
          .disabled(model.loading || model.projectID.isEmpty || model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("session-search-submit")
      }
      Section("此电脑的原生记录索引") {
        if let status = model.status {
          Text("\(status.node) · \(status.state == "indexing" ? "索引中" : "就绪")").font(.caption)
          ForEach(status.sources) { source in
            DisclosureGroup("\(source.provider) · \(source.sessions) 个会话 · \(source.status)") {
              ForEach(source.issues, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
            }
          }
        }
        Button("更新索引") { Task { await model.refresh(session: session) } }.disabled(model.status?.state == "indexing")
      }
      if let failure = model.failure { Text(failure).foregroundColor(.orange) }
      if model.page?.partial == true { Text("结果覆盖不完整，请查看索引状态。").foregroundColor(.secondary) }
      ForEach(model.hits) { hit in
        NavigationLink { SessionSearchDetail(session: session, hitID: hit.id).id(session.generation) } label: {
          VStack(alignment: .leading, spacing: 8) {
            Text(hit.title).font(.headline).lineLimit(2)
            Text("\(hit.provider) · \(hit.kind) · \(hit.projectPath)").font(.caption).foregroundColor(.secondary)
            Text(hit.text).font(.subheadline).lineLimit(5)
          }.padding(.vertical, 6)
        }
      }
      if model.loading { ProgressView() }
      if model.page != nil && model.hits.isEmpty { Text("没有匹配的会话。可减少关键词或扩大范围。").foregroundColor(.secondary) }
      if model.page?.nextCursor != nil { Button("更多会话") { Task { await model.search(session: session, more: true) } }.disabled(model.loading) }
    }
    .navigationTitle("会话搜索")
    .onChange(of: model.filter) { _ in model.clear() }
    .onChange(of: session.generation) { _ in model.reset() }
    .onDisappear { model.suspend() }
    .task(id: "\(session.generation):\(session.foreground):\(session.authenticated)") {
      guard session.foreground, session.authenticated else { return }
      if model.projectID.isEmpty { model.projectID = session.overview?.projects.first(where: { !$0.isDefault && $0.path != nil })?.id ?? "" }
      while !Task.isCancelled {
        await model.poll(session: session)
        do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
      }
    }
  }
}

private struct SessionSearchDetail: View {
  @ObservedObject var session: AppSession
  let hitID: String
  @State private var context: SessionSearchContext?
  @State private var failure: String?
  var body: some View {
    List {
      if let failure { Text(failure).foregroundColor(.orange) }
      if let context {
        Text(context.sourceState == "verified" ? "已核对原文" : "原文已变化或缺失，请更新索引后重新搜索。")
        if context.partial { Text("这是局部上下文，存在长度限制或覆盖缺口。").foregroundColor(.secondary) }
        Section("命中记录") { record(context.hit) }
        if !context.paired.isEmpty {
          Section("同一调用的请求与结果") { ForEach(context.paired) { record($0) } }
        }
        Section { DisclosureGroup("前后记录") { ForEach(context.records.filter { $0.id != context.hit.id }) { record($0) } } }
      } else if failure == nil { ProgressView() }
    }.navigationTitle("原生记录").navigationBarTitleDisplayMode(.inline)
      .task(id: "\(session.generation):\(hitID)") {
        context = nil; failure = nil
        guard let api = session.api, session.authenticated else { return }
        let epoch = session.generation
        do {
          let value = try await SessionSearchService(api: api).context(hitID)
          guard session.generation == epoch, !Task.isCancelled else { return }
          context = value
        } catch {
          guard session.generation == epoch, !Task.isCancelled else { return }
          failure = "无法读取原文，请返回并重新搜索。"
          await session.handle(error, epoch: epoch, reportFailure: false)
        }
      }
  }
  private func record(_ hit: SessionSearchHit) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(hit.kind) · \(hit.toolName ?? hit.provider)").font(.caption).foregroundColor(.secondary)
      Text(hit.text.isEmpty ? "原文无法核对" : hit.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
      Text("\(hit.location.path):\(hit.location.line)").font(.caption2).foregroundColor(.secondary).textSelection(.enabled)
    }.padding(.vertical, 5)
  }
}
