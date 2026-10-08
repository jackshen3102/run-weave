import SwiftUI
import MarkdownUI

struct ScheduledContinuationView: View {
  @ObservedObject var session: AppSession
  let run: ScheduledRun
  let refresh: () async -> Void
  @State private var busy = false
  @State private var failure: String?
  @State private var expanded = false
  @State private var attempts: [ScheduledRun.Attempt] = []
  @State private var requestRevision: Int?
  @State private var requestKey = UUID().uuidString
  @State private var operation: Task<Void, Never>?
  private var active: Bool { session.foreground && session.health.status == .online }

  var body: some View {
    if let state = run.continuation {
      VStack(alignment: .leading, spacing: 8) {
        Text("自动继续 \(state.count)/\(state.maxAttempts) 次").font(.subheadline)
        if let next = state.nextAt { Text("等待恢复 · 下次继续：\(scheduledDate(next))").font(.caption) }
        if let reason = state.stopReason { Text(reason).font(.caption).foregroundColor(.orange) }
        if let recovery = state.recovery { Text(recovery.nextStep).font(.caption).textSelection(.enabled) }
        if run.waitingContinuation {
          HStack {
            Button("立即继续") { change(stop: false) }
            Button("停止自动继续", role: .destructive) { change(stop: true) }
          }.buttonStyle(.borderless).disabled(busy || !active || !session.canWrite)
        }
        if let failure { Text(failure).font(.caption).foregroundColor(.red) }
        DisclosureGroup("每轮进展", isExpanded: $expanded) {
          ForEach(attempts) { attempt in
            VStack(alignment: .leading, spacing: 6) {
              Text("第 \(attempt.sequence) 轮 · \(scheduledDate(attempt.startedAt)) · \(attempt.finishedAt == nil ? "执行中" : "已结束")").font(.caption)
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

  private func change(stop: Bool) {
    guard !busy, active, session.canWrite else { return }
    let generation = session.generation
    if requestRevision != run.revision { requestRevision = run.revision; requestKey = UUID().uuidString }
    let revision = requestRevision ?? 0
    let key = requestKey
    busy = true; failure = nil
    operation = Task {
      defer { busy = false }
      do {
        _ = try await session.withConnection(reportFailure: false) { api in
          let service = ScheduledTasksService(api: api)
          return try await stop ? service.stop(run.id) : service.continueRun(run.id, revision: revision, key: key)
        }
        guard !Task.isCancelled, session.generation == generation else { return }
        await refresh()
      } catch {
        if !Task.isCancelled, session.generation == generation { failure = displayError(error) }
      }
    }
  }
}
