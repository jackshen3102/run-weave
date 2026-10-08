import SwiftUI
import MarkdownUI

struct ScheduledContinuationView: View {
  @ObservedObject var session: AppSession
  let run: ScheduledRun
  let refresh: () async -> Void
  @State private var reply = ""
  @State private var requestReply: String?
  @State private var busy = false
  @State private var failure: String?
  @State private var expanded = false
  @State private var attempts: [ScheduledRun.Attempt] = []
  @State private var requestRevision: Int?
  @State private var requestKey = UUID().uuidString
  @State private var operation: Task<Void, Never>?
  private var active: Bool { session.foreground && session.health.status == .online }

  var body: some View {
    if run.continuation != nil || run.replyUnavailable == nil {
      let state = run.continuation
      VStack(alignment: .leading, spacing: 8) {
        Text("自动重试 \(state?.count ?? 0)/\(state?.maxAttempts ?? 3) 次").font(.subheadline)
        if let next = state?.nextAt { Text("等待恢复 · 下次继续：\(scheduledDate(next))").font(.caption) }
        if ["queued", "running", "stopping"].contains(run.status) {
          if run.continuationInput != nil { Text("已收到你的回复，正在继续处理。").font(.caption) }
        } else {
          if let reason = state?.stopReason { Text(reason).font(.caption).foregroundColor(.orange) }
          if let recovery = state?.recovery { Text(recovery.nextStep).font(.caption).textSelection(.enabled) }
          if state?.recovery?.action == "needs-input" { Text("等待你的回复；自动重试不能代替你的回答或授权。").font(.caption).foregroundColor(.orange) }
        }
        if run.replyUnavailable == nil {
          if let confirmation = state?.recovery?.confirmation {
            Text("待确认：\(confirmation)").font(.caption)
            Button("允许并继续") { change(stop: false, reply: "确认：\(confirmation)。允许按上述事项继续。") }
              .disabled(busy || !active || !session.canWrite)
          }
          TextField("直接回复 Agent，补充范围、条件及说明", text: $reply, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
          HStack {
            Button("发送并继续") { change(stop: false, reply: reply.trimmingCharacters(in: .whitespacesAndNewlines)) }
              .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reply.count > 8000)
            if state?.recovery?.action != "needs-input" {
              Button("重试") { change(stop: false, reply: "请重新核对当前条件，在原授权范围内继续尚未完成的任务。") }
            }
          }.disabled(busy || !active || !session.canWrite)
        } else if ["failed", "cancelled"].contains(run.status), let reason = run.replyUnavailable {
          Text(reason).font(.caption).foregroundColor(.secondary)
        }
        if run.waitingContinuation {
          HStack {
            Button("立即继续") { change(stop: false) }
            Button("停止自动重试", role: .destructive) { change(stop: true) }
          }.buttonStyle(.borderless).disabled(busy || !active || !session.canWrite)
        }
        if let failure { Text(failure).font(.caption).foregroundColor(.red) }
        DisclosureGroup("每轮进展", isExpanded: $expanded) {
          ForEach(attempts) { attempt in
            VStack(alignment: .leading, spacing: 6) {
              Text("第 \(attempt.sequence) 轮 · \(scheduledDate(attempt.startedAt)) · \(attempt.finishedAt == nil ? "执行中" : "已结束")").font(.caption)
              if let input = attempt.userReply { Text("你的回复：\(input)").font(.caption) }
              if let summary = attempt.summary { Markdown(summary).markdownTheme(.gitHub).font(.caption) }
              if let error = attempt.error { Text(error.message).font(.caption).foregroundColor(.orange) }
            }.padding(.vertical, 6)
          }
        }.font(.caption)
      }
      .padding(12).background(Color.secondary.opacity(0.08)).cornerRadius(10)
      .task(id: "\(expanded):\(active):\(run.revision ?? 0)") {
        guard expanded, active else { return }
        let generation = session.generation
        do {
          let detail = try await session.withConnection(reportFailure: false) { try await ScheduledTasksService(api: $0).run(run.id) }
          guard !Task.isCancelled, session.generation == generation else { return }
          attempts = detail.attempts ?? []
        } catch { if !Task.isCancelled { failure = displayError(error) } }
      }
      .onDisappear { operation?.cancel() }
      .onChange(of: active) { if !$0 { operation?.cancel() } }
    }
  }

  private func change(stop: Bool, reply userReply: String? = nil) {
    guard !busy, active, session.canWrite else { return }
    let generation = session.generation
    if requestRevision != run.revision || requestReply != userReply { requestRevision = run.revision; requestReply = userReply; requestKey = UUID().uuidString }
    let revision = requestRevision ?? 0
    let key = requestKey
    busy = true; failure = nil
    operation = Task {
      defer { busy = false }
      do {
        _ = try await session.withConnection(reportFailure: false) { api in
          let service = ScheduledTasksService(api: api)
          return try await stop ? service.stop(run.id) : service.continueRun(run.id, revision: revision, key: key, reply: userReply)
        }
        guard !Task.isCancelled, session.generation == generation else { return }
        reply = ""
        await refresh()
      } catch {
        if !Task.isCancelled, session.generation == generation {
          failure = displayError(error)
          await refresh()
        }
      }
    }
  }
}
