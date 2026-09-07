import SwiftUI

@MainActor final class ReviewModel: ObservableObject {
  struct Turn: Identifiable { let question: String; let review: SuijiReview; var id: String { review.id } }
  @Published var question = ""
  @Published var scope = ReviewScope.all
  @Published var turns: [Turn] = []
  @Published var job: SuijiReview?
  @Published var message = ""
  @Published var starting = false
  @Published var pending = false
  private weak var session: SuijiSession?
  private var payload: Data?
  private var pendingQuestion = ""
  private var key = UUID().uuidString
  private var watcher: Task<Void, Never>?
  var running: Bool { starting || job?.status == "running" }
  init(session: SuijiSession) { self.session = session }
  func submit() async {
    guard !running, let session, let client = session.client else { return }
    starting = true; message = ""
    defer { starting = false }
    do {
      if payload == nil {
        guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, question.count <= 4000 else { throw MessageError(message: "问题需为 1～4,000 字") }
        let history = turns.flatMap { turn in [ReviewInput.Message(role: "user", text: turn.question), ReviewInput.Message(role: "assistant", text: turn.review.answer?.text ?? "")] }
        payload = try JSONEncoder().encode(ReviewInput(question: question, scope: scope, history: Array(history.suffix(6))))
        pendingQuestion = question; key = UUID().uuidString; pending = true
      }
      let result = try await client.request(SuijiReview.self, path: "api/suiji/v1/reviews", method: "POST", data: payload, key: key)
      guard session.isCurrent(client) else { return }
      receive(result)
      if result.status == "running" { watch() }
    } catch { if session.isCurrent(client) { message = error.localizedDescription + "。问题已保留，可手动确认同一次请求。" } }
  }
  private func receive(_ value: SuijiReview) {
    job = value
    guard value.status != "running" else { return }
    watcher?.cancel(); watcher = nil
    if value.status == "completed", value.answer != nil {
      if !turns.contains(where: { $0.id == value.id }) { turns.append(Turn(question: pendingQuestion, review: value)) }
      question = ""; message = ""
    } else { message = value.error ?? (value.status == "cancelled" ? "已取消回顾，原问题保留" : "回顾未完成") }
    payload = nil; pending = false
  }
  private func watch() {
    watcher?.cancel()
    watcher = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .milliseconds(1500)) } catch { return }
        guard let self, let session = self.session, let client = session.client, let id = self.job?.id else { return }
        do {
          let value = try await client.request(SuijiReview.self, path: "api/suiji/v1/reviews/\(id)")
          guard !Task.isCancelled, session.isCurrent(client) else { return }
          self.receive(value); if value.status != "running" { return }
        } catch {
          if !Task.isCancelled, session.isCurrent(client) { self.message = error.localizedDescription + "。可手动查询进度；服务重启后的回顾会失效。" }
          return
        }
      }
    }
  }
  func refresh() async {
    guard let session, let client = session.client, let id = job?.id else { return }
    do {
      let value = try await client.request(SuijiReview.self, path: "api/suiji/v1/reviews/\(id)")
      guard session.isCurrent(client) else { return }
      message = ""; receive(value); if value.status == "running" { watch() }
    } catch { if session.isCurrent(client) { message = error.localizedDescription } }
  }
  func cancel() async {
    guard let session, let client = session.client, let id = job?.id else { return }
    do {
      let value = try await client.request(SuijiReview.self, path: "api/suiji/v1/reviews/\(id)", method: "DELETE")
      guard session.isCurrent(client) else { return }; receive(value)
    } catch { if session.isCurrent(client) { message = error.localizedDescription } }
  }
  func stopWatching() { watcher?.cancel(); watcher = nil }
  func endWaiting() { stopWatching(); job = nil; payload = nil; pending = false; message = "原问题保留，服务上已有的回顾仍受时间上限约束。" }
}
