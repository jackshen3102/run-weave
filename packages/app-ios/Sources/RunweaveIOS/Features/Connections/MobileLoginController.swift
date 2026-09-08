import SwiftUI
import UIKit

@MainActor
final class MobileLoginController: ObservableObject {
  @Published private(set) var scanning = true
  @Published private(set) var busy = false
  @Published private(set) var saved = false
  @Published private(set) var message = "将相机对准电脑的 Runweave 登录二维码"
  @Published private(set) var failure: String?
  private let store: ConnectionStore
  private let session: AppSession
  private let onConnected: () -> Void
  private let originalScope: String?
  private let originalSessionGeneration: Int
  private var generation = 0
  private var foreground = true
  private var task: Task<Void, Never>?
  private var attempt: Attempt?

  private struct Attempt {
    let qr: MobileLoginQR
    let claimantToken: String
    let prepared: ConnectionStore.PreparedMobileConnection
    let client: MobileLoginClient
    let credentialClient: APIClient
    let ownsCredentialClient: Bool
    var claimed = false
    var result: MobileLoginResult?
  }

  init(store: ConnectionStore, session: AppSession, onConnected: @escaping () -> Void) {
    self.store = store
    self.session = session
    self.onConnected = onConnected
    originalScope = store.active?.scope
    originalSessionGeneration = session.generation
  }

  /// Returns true only for the first valid frame, so the scanner can release its capture session.
  func scanned(_ text: String) -> Bool {
    guard scanning, attempt == nil, foreground else { return false }
    do {
      let qr = try MobileLoginQR.parse(text)
      let prepared = try store.prepareMobileLogin(base: qr.baseUrl, name: qr.connectionName)
      let active = session.connection?.scope == prepared.connection.scope ? session.api : nil
      let credentials = try active ?? APIClient(base: prepared.connection.url, connectionID: prepared.connection.id)
      attempt = Attempt(qr: qr, claimantToken: try MobileLoginClient.claimantToken(), prepared: prepared,
        client: MobileLoginClient(base: try MobileLoginQR.validatedBase(qr.baseUrl)),
        credentialClient: credentials, ownsCredentialClient: active == nil)
      scanning = false
      retry()
      return true
    } catch {
      failure = (error as? MobileLoginFailure)?.message ?? "二维码无效，请重新扫码或使用手动登录。"
      return false
    }
  }

  func scannerFailed(_ message: String) { failure = message }

  func retry() {
    guard foreground, attempt != nil, !busy else { return }
    let epoch = generation
    failure = nil
    busy = true
    task = Task { [weak self] in
      guard let self else { return }
      defer { if self.generation == epoch { self.busy = false; self.task = nil } }
      do { try await self.run(epoch: epoch) }
      catch {
        guard self.generation == epoch, !Task.isCancelled else { return }
        self.failure = self.saved ? "登录已保存，但未收到电脑确认回执。可以重试确认或进入首页。" :
          (error as? MobileLoginFailure)?.message ?? "当前阶段未完成，请重试；原连接仍保留。"
      }
    }
  }

  private func check(_ epoch: Int) throws {
    guard epoch == generation, foreground, !Task.isCancelled,
      store.active?.scope == originalScope, session.generation == originalSessionGeneration
    else { throw CancellationError() }
  }

  private func run(epoch: Int) async throws {
    guard var value = attempt else { return }
    try check(epoch)
    if !saved {
      if value.result == nil {
        if !value.claimed {
          message = value.qr.expiry.map { $0 <= Date() } == true
            ? "手机时间显示二维码可能过期，正在向电脑核对…"
            : "正在连接 \(value.prepared.connection.name)…"
          try await value.client.claim(value.qr, claimantToken: value.claimantToken,
            deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone",
            connectionID: value.credentialClient.connectionID)
          try check(epoch)
          value.claimed = true
          attempt = value
        }
        message = "等待电脑确认 · \(value.prepared.connection.name)"
        while value.result == nil {
          let result = try await value.client.exchange(value.qr.requestId, claimantToken: value.claimantToken)
          try check(epoch)
          if let result { value.result = result; attempt = value; break }
          try await Task.sleep(nanoseconds: 1_000_000_000)
        }
      }
      guard let result = value.result else { throw APIError.invalidResponse }
      message = "正在保存登录…"
      try await value.credentialClient.importMobileLogin(result) { [self] in
        try check(epoch)
        try store.commitMobileLogin(value.prepared)
      }
      try check(epoch)
      saved = true
    }
    guard let result = value.result else { throw APIError.invalidResponse }
    message = "登录已保存，正在通知电脑…"
    try await value.client.complete(value.qr.requestId, claimantToken: value.claimantToken, accessToken: result.accessToken)
    try check(epoch)
    enterHome()
  }

  func enterHome() {
    guard saved, let value = attempt, store.active?.scope == originalScope,
      session.generation == originalSessionGeneration else { return }
    do {
      try store.select(value.prepared.connection.id)
      onConnected()
    } catch { failure = "登录已保存，但切换连接失败。请返回连接管理重试。" }
  }

  func setForeground(_ value: Bool) {
    foreground = value
    if !value {
      generation += 1
      task?.cancel(); task = nil; busy = false
    } else if attempt != nil { retry() }
  }

  func cancel() {
    generation += 1
    task?.cancel(); task = nil; busy = false
    let previous = attempt
    attempt = nil
    if let previous {
      Task {
        if !saved { await previous.client.cancel(previous.qr.requestId, claimantToken: previous.claimantToken) }
        previous.client.close()
        if previous.ownsCredentialClient { await previous.credentialClient.close() }
      }
    }
  }

  func scanAgain() {
    guard !saved else { return }
    cancel()
    failure = nil
    scanning = true
    message = "将相机对准电脑的 Runweave 登录二维码"
  }
}
