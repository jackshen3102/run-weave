import Foundation
import UIKit
import UserNotifications

@MainActor
public final class NotificationCoordinator: ObservableObject {
  public static let shared = NotificationCoordinator()
  @Published private(set) var bindings: [String: NotificationBinding] = [:]
  @Published var message: String?
  @Published var pendingHostID: String?
  private let vault = CredentialStore()
  private let account = "native.notifications.v1"
  private var installation = UUID().uuidString
  private var deviceToken: String?
  private var tokenWaiters: [UUID: CheckedContinuation<String, Error>] = [:]
  private var versions: [String: Int] = [:]
  private var knownHosts: [String: String] = [:]
  private var successfulAt: [String: Date] = [:]
  private var seen: [String] = []
  private var validStorage = true
  private var refreshing = false
  private var refreshAgain = false
  private var tokenConfirmed = false
  private var resumeTask: Task<Void, Never>?
  private struct Stored: Codable {
    var installation: String
    var deviceToken: String?
    var bindings: [String: NotificationBinding]
    var knownHosts: [String: String]
    var successfulAt: [String: Date]
  }
  private init() {
    do {
      if let data = try vault.read(account) {
        let value = try JSONDecoder().decode(Stored.self, from: data)
        installation = value.installation
        deviceToken = value.deviceToken
        bindings = value.bindings
        knownHosts = value.knownHosts
        successfulAt = value.successfulAt
      }
    } catch {
      validStorage = false
      message = "提醒设置无法读取，原数据已保留"
    }
  }
  private func persist() throws {
    guard validStorage else { throw AttachmentError("提醒设置无法读取") }
    try vault.write(
      JSONEncoder().encode(
        Stored(
          installation: installation, deviceToken: deviceToken,
          bindings: bindings, knownHosts: knownHosts, successfulAt: successfulAt)), account: account
    )
  }
  func note(_ snapshot: DeviceStatusSnapshot, connection: BackendConnection) {
    guard snapshot.protocolVersion == 1, snapshot.sampleStatus == "ok" else { return }
    knownHosts[connection.scope] = snapshot.hostId
    successfulAt[connection.scope] = Date()
    do { try persist() } catch { message = "提醒设置保存失败" }
  }
  func consume(in store: ConnectionStore) {
    guard let host = pendingHostID else { return }
    pendingHostID = nil
    let candidates = store.connections.filter { knownHosts[$0.scope] == host }
    let selected =
      candidates.first { $0.id == store.activeID }
      ?? candidates.max {
        (successfulAt[$0.scope] ?? .distantPast) < (successfulAt[$1.scope] ?? .distantPast)
      }
    guard let selected else {
      message = "此电脑连接已移除"
      return
    }
    do { try store.select(selected.id) } catch { message = displayError(error) }
  }
  func enable(_ connection: BackendConnection) async throws {
    guard validStorage else { throw AttachmentError("提醒设置无法读取") }
    let api = try APIClient(base: connection.url, connectionID: connection.id)
    defer { Task { await api.close() } }
    let availability = try await api.notificationStatus()
    guard availability.available else { throw AttachmentError(availability.reason ?? "推送暂不可用") }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    if settings.authorizationStatus == .notDetermined {
      guard
        try await UNUserNotificationCenter.current().requestAuthorization(options: [
          .alert, .sound, .badge,
        ])
      else {
        throw AttachmentError("系统通知未允许，可在 iOS 设置中开启")
      }
    } else if settings.authorizationStatus == .denied {
      throw AttachmentError("系统通知未允许，可在 iOS 设置中开启")
    }
    guard let environment else { throw AttachmentError("当前签名未配置推送环境") }
    if bindings[connection.scope]?.pendingRevoke == true {
      await disable(connection, client: api)
      guard bindings[connection.scope]?.pendingRevoke != true else {
        throw AttachmentError("远端提醒关闭尚未确认")
      }
    }
    let version = (versions[connection.scope] ?? 0) + 1
    versions[connection.scope] = version
    let token = try await registrationToken()
    guard versions[connection.scope] == version else { throw CancellationError() }
    bindings[connection.scope] = NotificationBinding(
      connection: connection, enabled: true, pendingRevoke: false)
    try persist()
    do {
      let response = try await api.registerNotifications(
        installation: installation, token: token,
        environment: environment, name: connection.name, explicit: true)
      guard versions[connection.scope] == version, bindings[connection.scope]?.enabled == true
      else {
        try? await directRevoke(response)
        return
      }
      bindings[connection.scope]?.subscription = response
      knownHosts[connection.scope] = response.hostId
      try persist()
      if response.revokeToken != nil, UIApplication.shared.applicationState != .background {
        let confirmed = try await api.confirmNotifications(response)
        if versions[connection.scope] == version, bindings[connection.scope]?.enabled == true {
          bindings[connection.scope]?.subscription = confirmed
          try persist()
        }
      }
      if response.state == "disabled" {
        bindings[connection.scope]?.enabled = false
        try persist()
      }
    } catch {
      // A lost response can still have created a binding. Retain a revocation intent.
      await disable(connection, client: api)
      throw error
    }
  }
  var environment: String? {
    #if targetEnvironment(simulator)
      return nil
    #else
      let value = Bundle.main.object(forInfoDictionaryKey: "RunweaveAPNsEnvironment") as? String
      return value == "sandbox" || value == "production" ? value : nil
    #endif
  }
  private func registrationToken() async throws -> String {
    let id = UUID()
    return try await withCheckedThrowingContinuation { continuation in
      tokenWaiters[id] = continuation
      UIApplication.shared.registerForRemoteNotifications()
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 15_000_000_000)
        self?.tokenWaiters.removeValue(forKey: id)?.resume(
          throwing: AttachmentError("系统推送注册超时，请稍后重试"))
      }
    }
  }
  public func registered(_ token: Data) {
    let encoded = token.map { String(format: "%02x", $0) }.joined()
    deviceToken = encoded
    tokenConfirmed = true
    do { try persist() } catch { message = "推送注册保存失败" }
    for waiter in tokenWaiters.values { waiter.resume(returning: encoded) }
    tokenWaiters.removeAll()
    if UIApplication.shared.applicationState != .background { Task { await refreshEnabled() } }
  }
  public func registrationFailed() {
    for waiter in tokenWaiters.values {
      waiter.resume(throwing: AttachmentError("系统推送注册失败，请检查签名和网络"))
    }
    tokenWaiters.removeAll()
    message = "系统推送注册失败，请检查签名和网络"
  }
  func disable(_ connection: BackendConnection, client supplied: APIClient? = nil) async {
    guard var binding = bindings[connection.scope] else { return }
    versions[connection.scope, default: 0] += 1
    binding.enabled = false
    binding.pendingRevoke = true
    bindings[connection.scope] = binding
    do { try persist() } catch {
      message = "关闭提醒状态保存失败"
      return
    }
    var revoked = false
    if let api = supplied ?? (try? APIClient(base: connection.url, connectionID: connection.id)) {
      do {
        try await api.revokeNotifications(installation: installation)
        revoked = true
      } catch {}
      if supplied == nil { await api.close() }
    }
    // Backend 204 may only have queued a gateway revocation. Confirm directly when possible.
    if let subscription = binding.subscription, subscription.revokeToken != nil {
      do {
        try await directRevoke(subscription)
        revoked = true
      } catch { revoked = false }
    }
    if revoked {
      bindings[connection.scope]?.pendingRevoke = false
      bindings[connection.scope]?.subscription = nil
      do { try persist() } catch { message = "关闭提醒状态保存失败" }
    } else {
      message = "远端提醒关闭尚未确认"
    }
  }
  private func directRevoke(_ subscription: DeviceNotificationSubscription) async throws {
    guard let raw = subscription.gatewayURL, let token = subscription.revokeToken,
      var components = URLComponents(string: raw), components.scheme == "https",
      components.user == nil, components.password == nil, components.query == nil,
      components.fragment == nil,
      components.path.isEmpty || components.path == "/"
    else { throw APIError.invalidURL }
    components.path = "/v1/subscriptions/\(subscription.subscriptionId)"
    guard let url = components.url else { throw APIError.invalidURL }
    var request = URLRequest(url: url)
    request.httpMethod = "DELETE"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 10
    let network = URLSession(
      configuration: .ephemeral, delegate: NoPushRedirect(), delegateQueue: nil)
    defer { network.invalidateAndCancel() }
    let (_, response) = try await network.data(for: request)
    guard let http = response as? HTTPURLResponse, [204, 404, 410].contains(http.statusCode) else {
      throw APIError.invalidResponse
    }
  }
  func suspend() {
    resumeTask?.cancel()
    resumeTask = nil
  }
  func foreground() {
    tokenConfirmed = false
    if bindings.values.contains(where: { $0.enabled }), environment != nil {
      UIApplication.shared.registerForRemoteNotifications()
    }
    resumeTask?.cancel()
    resumeTask = Task { await refreshEnabled() }
  }
  func refreshEnabled() async {
    guard !refreshing else {
      refreshAgain = true
      return
    }
    refreshing = true
    defer {
      refreshing = false
      if refreshAgain, !Task.isCancelled {
        refreshAgain = false
        Task { await refreshEnabled() }
      }
    }
    // Sequential requests stay within the three-connection limit and serialize revoke before sync.
    for binding in Array(bindings.values) where binding.pendingRevoke {
      guard !Task.isCancelled, UIApplication.shared.applicationState != .background else { return }
      await disable(binding.connection)
    }
    guard tokenConfirmed, let deviceToken, let environment else { return }
    for binding in Array(bindings.values) where binding.enabled && !binding.pendingRevoke {
      guard !Task.isCancelled, UIApplication.shared.applicationState != .background else { return }
      let scope = binding.connection.scope
      let version = versions[scope] ?? 0
      guard
        let api = try? APIClient(base: binding.connection.url, connectionID: binding.connection.id)
      else { continue }
      do {
        let result = try await api.registerNotifications(
          installation: installation, token: deviceToken,
          environment: environment, name: binding.connection.name, explicit: false)
        if versions[scope] ?? 0 == version, bindings[scope]?.enabled == true {
          bindings[scope]?.subscription = result
          if result.state == "disabled" { bindings[scope]?.enabled = false }
          try persist()
          if result.revokeToken != nil, result.state != "disabled", !Task.isCancelled, UIApplication.shared.applicationState != .background {
            let confirmed = try await api.confirmNotifications(result)
            if versions[scope] ?? 0 == version, bindings[scope]?.enabled == true {
              bindings[scope]?.subscription = confirmed
              try persist()
            }
          }
        } else {
          try? await directRevoke(result)
        }
      } catch { message = "部分电脑的提醒注册待更新" }
      await api.close()
    }
  }
  public func received(_ info: [AnyHashable: Any], tapped: Bool) -> Bool {
    guard let push = BatteryPush(info) else { return false }
    if tapped { pendingHostID = push.hostID }
    guard !seen.contains(push.notificationID) else { return false }
    seen.append(push.notificationID)
    if seen.count > 256 { seen.removeFirst(seen.count - 256) }
    return true
  }
}

private final class NoPushRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
