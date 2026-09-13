import Foundation

@MainActor
final class CodexQuotaStore: ObservableObject {
  @Published private(set) var snapshot: CodexQuotaSnapshot?
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  private var task: Task<Void, Never>?
  private var revision = 0
  private var receivedAt = ProcessInfo.processInfo.systemUptime

  var stale: Bool {
    guard let age = snapshot?.sampleAgeMs else { return false }
    return age + (ProcessInfo.processInfo.systemUptime - receivedAt) * 1000 >= 300_000
  }

  func cancel() {
    revision += 1
    task?.cancel()
    task = nil
    loading = false
  }

  func reset() {
    cancel()
    snapshot = nil
    failure = nil
  }

  func refresh(session: AppSession, force: Bool = false) {
    cancel()
    let epoch = revision
    loading = true
    failure = nil
    task = Task {
      defer { if epoch == revision { loading = false; task = nil } }
      do {
        let next = try await session.withConnection(reportFailure: false) { api in
          try await api.codexQuota(force: force)
        }
        guard epoch == revision, !Task.isCancelled else { return }
        guard next.protocolVersion == 1 else {
          failure = "当前版本不支持 Codex 额度"
          return
        }
        if next.observedAt == nil && ["unavailable", "incompatible"].contains(next.status) {
          failure = next.message
        } else {
          snapshot = next
          receivedAt = ProcessInfo.processInfo.systemUptime
        }
      } catch {
        guard epoch == revision, !Task.isCancelled else { return }
        if case APIError.credentialsUnavailable = error {
          reset()
          return
        }
        if case APIError.http(404) = error {
          failure = "当前 Backend 版本不支持 Codex 额度"
        } else {
          failure = "额度更新失败，请确认当前连接已登录后重试"
        }
      }
    }
  }
}
