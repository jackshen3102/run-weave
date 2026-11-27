import Foundation

@MainActor
final class CodexQuotaStore: ObservableObject {
  @Published private(set) var snapshot: CodexQuotaSnapshot?
  @Published private(set) var agySnapshot: AgyQuotaSnapshot?
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  @Published private(set) var agyFailure: String?
  private var task: Task<Void, Never>?
  private var revision = 0
  private var receivedAt = ProcessInfo.processInfo.systemUptime
  private var agyReceivedAt = ProcessInfo.processInfo.systemUptime

  var stale: Bool {
    guard let age = snapshot?.sampleAgeMs else { return false }
    return age + (ProcessInfo.processInfo.systemUptime - receivedAt) * 1000 >= 300_000
  }

  var agyStale: Bool {
    guard let age = agySnapshot?.sampleAgeMs else { return false }
    return age + (ProcessInfo.processInfo.systemUptime - agyReceivedAt) * 1000 >= 300_000
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
    agySnapshot = nil
    failure = nil
    agyFailure = nil
  }

  func refresh(session: AppSession, force: Bool = false) {
    cancel()
    let epoch = revision
    loading = true
    failure = nil
    agyFailure = nil
    task = Task {
      defer { if epoch == revision { loading = false; task = nil } }
      await withTaskGroup(of: Void.self) { group in
        group.addTask { await self.refreshAgy(session: session, force: force, epoch: epoch) }
        group.addTask { await self.refreshCodex(session: session, force: force, epoch: epoch) }
      }
    }
  }

  private func refreshAgy(session: AppSession, force: Bool, epoch: Int) async {
    do {
      let next = try await session.withConnection(reportFailure: false) { api in
        try await api.agyQuota(force: force)
      }
      guard epoch == revision, !Task.isCancelled else { return }
      guard next.protocolVersion == 1 else {
        agyFailure = "当前版本不支持 AGY 额度"
        return
      }
      if next.observedAt == nil && ["unavailable", "incompatible"].contains(next.status) {
        agyFailure = next.message
      } else {
        agySnapshot = next
        agyReceivedAt = ProcessInfo.processInfo.systemUptime
      }
    } catch {
      guard epoch == revision, !Task.isCancelled else { return }
      if case APIError.credentialsUnavailable = error {
        reset()
        return
      }
      if case APIError.http(404) = error {
        agyFailure = "当前 Backend 版本不支持 AGY 额度"
      } else {
        agyFailure = "AGY 额度更新失败，请确认当前连接已登录后重试"
      }
    }
  }

  private func refreshCodex(session: AppSession, force: Bool, epoch: Int) async {
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
