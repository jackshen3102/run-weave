import SwiftUI

struct PrWatchSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let terminalID: String
  @State private var response: PrWatchResponse?
  @State private var selection = ""
  @State private var busy = false
  @State private var failure: String?
  private var path: String { "/api/terminal/session/\(APIClient.pathComponent(terminalID))/pr-watch" }

  var body: some View {
    NavigationView {
      Form {
        if let watch = response?.watch {
          Text("\(watch.repoNameWithOwner) #\(watch.prNumber) · \(watch.prTitle)")
          Text("\(watch.statusTitle) · 纯评论唤醒 \(watch.commentWakeCount)/10 · 连续读取失败 \(watch.consecutiveReadFailures)/8")
          if let summary = watch.lastSummary { Text(summary) }
          if watch.status == "watching" { Button("暂停值守") { change("pause", watch) } }
          if watch.status == "paused" && watch.pauseReason != "thread_changed" {
            let draft = watch.pauseReason == "draft_unconfirmed"
            Button(draft ? "确认输入框为空并发送" : "恢复值守") {
              change(draft ? "confirm_empty_draft_and_deliver" : "resume", watch)
            }
          }
          Button("关闭值守", role: .destructive) { Task { await perform("DELETE") } }
        } else {
          if let pr = response?.candidatePr { Text("当前分支 · #\(pr.prNumber) \(pr.prTitle)") }
          TextField("同仓库 PR 编号或 URL", text: $selection).textInputAutocapitalization(.never).autocorrectionDisabled()
          Button("开启值守") {
            var body: [String: Any] = ["operationId": UUID().uuidString]
            if selection.hasPrefix("https://") { body["prUrl"] = selection }
            else if let number = Int(selection) { body["prNumber"] = number }
            else { body["prUrl"] = response?.candidatePr?.prUrl }
            Task { await perform("POST", body) }
          }.disabled(selection.isEmpty ? response?.candidatePr == nil : Int(selection) == nil && !selection.hasPrefix("https://"))
        }
        if let failure { Text(failure).foregroundStyle(.red) }
      }
      .disabled(busy)
      .navigationTitle("PR 值守")
      .toolbar { Button("完成") { dismiss() } }
      .task {
        await perform("GET", detect: true)
        while !Task.isCancelled {
          do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
          if response?.watch != nil && !busy { await perform("GET") }
        }
      }
      .onChange(of: session.generation) { _ in dismiss() }
    }.navigationViewStyle(.stack)
  }

  private func change(_ action: String, _ watch: TerminalPrWatchState) {
    var body: [String: Any] = ["action": action, "expectedRevision": watch.revision]
    body["expectedInputVersion"] = response?.inputVersion
    Task { await perform("PATCH", body) }
  }

  @MainActor private func perform(_ method: String, _ body: [String: Any]? = nil, detect: Bool = false) async {
    guard !busy, let api = session.api else { return }
    busy = true
    defer { busy = false }
    do {
      if method == "DELETE" {
        let _: EmptyResponse = try await api.authorized(path, method: method, retryUnauthorized: false)
        response = nil
        response = try await api.authorized(path + "?detect=true")
      } else {
        response = try await api.authorized(path + (detect ? "?detect=true" : ""), method: method,
          body: body, retryUnauthorized: method == "GET")
      }
      failure = nil
    } catch APIError.http(409) {
      response = try? await api.authorized(path)
      failure = "值守或输入已变化，请核对最新状态后重试。"
    } catch { if !Task.isCancelled { failure = displayError(error) } }
  }
}
