import Clarity
import SwiftUI

struct TaskSupervisionDecisionView: View {
  let decision: SupervisionDecision
  let watchID: String
  @ObservedObject var model: TaskSupervisionModel
  @State private var detail: SupervisionDecision?
  @State private var failure: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        section("三分类相对评分") {
          ForEach(TaskOutcome.allCases, id: \.rawValue) { outcome in
            HStack(spacing: 12) {
              Text(outcome.label).frame(maxWidth: .infinity, alignment: .leading)
              Text(String(format: "%.1f", decision.scores.value(outcome) * 100)).monospacedDigit()
              ProgressView(value: min(1, max(0, decision.scores.value(outcome)))).frame(width: 70)
                .accessibilityHidden(true)
            }.font(.caption)
              .foregroundColor(outcome == decision.outcome ? TerminalAppearance.accent : .secondary)
          }
          Text("评分表示选项的相对倾向，不代表正确率。").font(.caption2).foregroundColor(.secondary)
        }
        section("判断理由") { Text(decision.reason).font(.subheadline).textSelection(.enabled) }
        if let input = detail?.input {
          section("完整最终回复") { sourceText(input.currentReply.text) }
          section("本次输入与来源") {
            NavigationLink("查看任务、范围修改与计划") { TaskSupervisionSourceView(input: input) }
              .font(.subheadline).accessibilityIdentifier("task-supervision-source-open")
          }
        } else if let failure {
          Text(failure).foregroundColor(.orange)
          Button("重试读取") { Task { await loadDetail() } }
        } else { ProgressView("正在读取判断依据…") }
        section("续接状态") {
          Text(decision.deliveryLabel).font(.subheadline)
          if ["offered", "unknown"].contains(decision.delivery) {
            Text("已保留额度，不会重复发送。原会话确认接收后状态将更新。")
              .font(.caption).foregroundColor(.orange)
          }
        }
        DisclosureGroup("监听身份与判定信息") {
          VStack(alignment: .leading, spacing: 10) {
            metadata("判断时间", decision.createdAt)
            metadata("模型", decision.model)
            if let version = decision.codexVersion { metadata("Codex 版本", version) }
            metadata("耗时", "\(decision.durationMs)ms")
            metadata("目标版本", decision.goalVersion.map { "v\($0)" } ?? "历史记录未保存")
            metadata("处理轮次", String(decision.contextRevision))
            metadata("判断 ID", decision.decisionId)
            if let thread = decision.threadId { metadata("会话", thread) }
            metadata("轮次", decision.rawTurnId)
            metadata("回复摘要", decision.replyDigest)
            metadata("投递状态", decision.delivery)
            metadata("来源消息", decision.sourceMessageIds.joined(separator: "\n"))
          }.padding(.top, 12)
        }.font(.caption).foregroundColor(.secondary)
      }.padding(20)
    }.background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("判断依据").navigationBarTitleDisplayMode(.inline).clarityMask()
      .task(id: decision.decisionId) { await loadDetail() }
  }

  private func loadDetail() async {
    failure = nil
    do { detail = try await model.detail(watchID: watchID, decisionID: decision.decisionId) }
    catch { if !Task.isCancelled { failure = error.localizedDescription } }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.caption).foregroundColor(.secondary)
      content()
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func metadata(_ name: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(name).fontWeight(.medium)
      Text(value).textSelection(.enabled)
    }
  }
}

struct TaskSupervisionSourceView: View {
  let input: SupervisionInput

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        section("原始任务") { sourceText(input.task.text) }
        section("当前目标") { sourceText(input.goal) }
        section("用户范围修改") {
          if input.userUpdates.isEmpty { Text("没有范围修改").font(.caption).foregroundColor(.secondary) }
          ForEach(input.userUpdates) { message in sourceText(message.text) }
        }
        section("相关计划") {
          if input.plan.isEmpty { Text("本次判断未引用计划文件").font(.caption).foregroundColor(.secondary) }
          ForEach(Array(input.plan.enumerated()), id: \.offset) { _, plan in
            VStack(alignment: .leading, spacing: 8) {
              Text(plan.path).font(.caption).textSelection(.enabled)
              sourceText(plan.text)
            }
          }
        }
        section("相关对话") {
          ForEach(input.recentExchanges) { message in
            VStack(alignment: .leading, spacing: 6) {
              Text(message.role == "user" ? "用户" : "Agent").font(.caption).foregroundColor(.secondary)
              sourceText(message.text)
            }
          }
        }
        DisclosureGroup("完整输入快照") { sourceText(input.snapshot).padding(.top, 10) }
          .font(.caption).accessibilityIdentifier("task-supervision-input-snapshot")
      }.padding(20)
    }.background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("输入与来源").navigationBarTitleDisplayMode(.inline).clarityMask()
  }
  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.caption).foregroundColor(.secondary)
      content()
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct TaskSupervisionActivityView: View {
  let watch: TaskWatch
  @ObservedObject var model: TaskSupervisionModel
  @State private var records: [SupervisionDecision] = []
  @State private var cursor: String?
  @State private var loaded = false
  @State private var loading = false
  @State private var failure: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        ForEach(records) { decision in
          NavigationLink { TaskSupervisionDecisionView(decision: decision, watchID: watch.watchId, model: model) } label: {
            VStack(alignment: .leading, spacing: 7) {
              HStack {
                Text(decision.outcome.label).font(.subheadline.weight(.medium))
                Spacer()
                Image(systemName: "chevron.right").font(.caption)
              }
              Text(decision.deliveryLabel).font(.caption).foregroundColor(.secondary)
              Text(decision.goalPreview).font(.caption).foregroundColor(.secondary).lineLimit(2)
              Text(decision.contextRevision == watch.contextRevision && decision.threadId == watch.target.threadId ? "当前轮" : "历史轮次")
                .font(.caption2).foregroundColor(.secondary)
              Text(decision.createdAt).font(.caption2).foregroundColor(.secondary)
              if let thread = decision.threadId {
                Text("thread \(thread)").font(.caption2).foregroundColor(.secondary).textSelection(.enabled)
              }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
              .background(Color.secondary.opacity(0.06)).cornerRadius(10)
          }.buttonStyle(.plain)
        }
        if let failure { Text(failure).font(.caption).foregroundColor(.orange) }
        if !loaded || cursor != nil {
          Button(loading ? "正在读取…" : failure != nil ? "重试" : "加载更多") { Task { await loadPage() } }.disabled(loading)
        }
        if loaded && records.isEmpty { Text("暂无历史判断").foregroundColor(.secondary) }
        Text("终端开关：\(watch.enabled ? "已开启" : "已关闭")").font(.subheadline)
        Text("开启于 \(watch.enabledAt)\n更新于 \(watch.updatedAt)").font(.caption).foregroundColor(.secondary)
        DisclosureGroup("监听身份") {
          sourceText("watch \(watch.watchId)\nterminal \(watch.target.terminalSessionId)\npanel \(watch.target.panelId)\nthread \(watch.target.threadId)\nexecutor \(watch.target.executorGeneration)")
        }.font(.caption)
      }.padding(20)
    }.background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("监控活动").navigationBarTitleDisplayMode(.inline).clarityMask()
      .task { if !loaded { await loadPage() } }
  }
  private func loadPage() async {
    guard !loading, !loaded || cursor != nil else { return }
    loading = true; failure = nil
    defer { loading = false }
    do {
      let page = try await model.history(watchID: watch.watchId, cursor: cursor)
      records.append(contentsOf: page.decisions); cursor = page.nextCursor; loaded = true
    } catch { if !Task.isCancelled { failure = error.localizedDescription } }
  }
}

private func sourceText(_ value: String) -> some View {
  Text(value).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled)
    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    .padding(14).background(TerminalAppearance.background).cornerRadius(10)
}
