import Clarity
import SwiftUI

struct SupervisionGoalHistoryView: View {
  @ObservedObject var model: TaskSupervisionModel
  let watchID: String
  @State private var entries: [SupervisionGoalPage.Entry] = []
  @State private var cursor: String?
  @State private var more = true
  @State private var loading = false
  @State private var failure: String?
  @State private var request = 0

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        ForEach(entries) { entry in
          NavigationLink {
            SupervisionGoalDetailView(model: model, watchID: watchID, revisionID: entry.id)
          } label: {
            VStack(alignment: .leading, spacing: 8) {
              Text("v\(entry.goal.version) · \(entry.goal.originLabel)").font(.headline)
              Text(entry.goal.createdAt).font(.caption2).foregroundColor(.secondary)
              Text(entry.goal.objective).font(.subheadline).lineLimit(3)
              Text(entry.reason).font(.caption).foregroundColor(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
              .background(Color.secondary.opacity(0.06)).cornerRadius(10)
          }.buttonStyle(.plain).accessibilityIdentifier("task-supervision-goal-revision-\(entry.goal.version)")
        }
        if let failure { Text(failure).font(.caption).foregroundColor(.orange) }
        if loading { ProgressView("正在读取目标版本…") }
        else if more {
          Button(failure == nil ? "加载更多" : "重试") { request += 1 }.disabled(!model.canRead)
            .accessibilityIdentifier("task-supervision-goal-load-more")
        } else if entries.isEmpty { Text("暂无已采用的目标版本。").foregroundColor(.secondary) }
      }.padding(20)
    }.background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("目标版本历史").navigationBarTitleDisplayMode(.inline).clarityMask()
      .task(id: request) { await load() }
  }

  private func load() async {
    guard more else { return }
    loading = true; failure = nil
    defer { loading = false }
    do {
      let page = try await model.goals(watchID: watchID, cursor: cursor)
      guard !Task.isCancelled else { return }
      let existing = Set(entries.map(\.id))
      entries.append(contentsOf: page.goals.filter { !existing.contains($0.id) })
      cursor = page.nextCursor; more = cursor != nil
    } catch { if !Task.isCancelled { failure = goalFailure(error) } }
  }
}

struct SupervisionGoalDetailView: View {
  @ObservedObject var model: TaskSupervisionModel
  let watchID: String
  let revisionID: String
  @State private var detail: SupervisionGoalDetail?
  @State private var failure: String?
  @State private var request = 0

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let detail {
          Text("v\(detail.goal.version) · \(detail.goal.originLabel)").font(.headline)
          goalText("任务目标", detail.goal.objective)
          goalText("完成条件", detail.goal.completionCriteria)
          goalText("范围与约束", detail.goal.constraints)
          Text("会话 \(detail.goal.threadId)").font(.caption2).foregroundColor(.secondary).textSelection(.enabled)
          SupervisionGoalSources(detail: detail)
        } else if let failure {
          Text(failure).foregroundColor(.orange)
          Button("重试") { request += 1 }.disabled(!model.canRead)
        } else { ProgressView("正在读取目标依据…") }
      }.padding(20)
    }.background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("目标依据").navigationBarTitleDisplayMode(.inline).clarityMask()
      .task(id: request) {
        failure = nil
        do { detail = try await model.goalDetail(watchID: watchID, revisionID: revisionID) }
        catch { if !Task.isCancelled { failure = goalFailure(error) } }
      }
  }
}

struct SupervisionGoalSources: View {
  let detail: SupervisionGoalDetail

  private var messages: [SupervisionMessage] {
    let ids = Set(detail.goal.sourceMessageIds + detail.goal.plans.flatMap { [$0.sourceMessageId, $0.authorizationMessageId] })
    return detail.messages.filter { ids.contains($0.id) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(detail.reason).font(.caption).foregroundColor(.secondary)
      ForEach(messages) { message in
        VStack(alignment: .leading, spacing: 8) {
          Text("\(message.role == "user" ? "你" : "Agent")\(message.id.hasPrefix("goal-manual:") ? " · 监控面板修订" : "") · \(message.createdAt ?? "原会话")")
            .font(.caption2).foregroundColor(.secondary)
          Text(message.text).font(.subheadline).textSelection(.enabled)
          ForEach(detail.goal.plans.filter { $0.authorizationMessageId == message.id }, id: \.path) { plan in
            Text("已承接计划：\(plan.path)").font(.caption).foregroundColor(TerminalAppearance.accent)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      ForEach(detail.plans, id: \.path) { plan in
        DisclosureGroup("\(plan.path) · \(plan.availability == "missing" ? "缺失" : "当时读取的内容")") {
          Text(plan.text.isEmpty ? "未取得计划正文。" : plan.text).font(.caption).textSelection(.enabled).padding(.top, 8)
        }.font(.caption)
      }
    }
  }
}
