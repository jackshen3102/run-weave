import Foundation
import UIKit
import UserNotifications

@MainActor
public final class NotificationCoordinator: ObservableObject {
  public static let shared = NotificationCoordinator()
  @Published private(set) var bindings: [String: NotificationBinding] = [:]
  @Published private(set) var refreshFailures: [String: String] = [:]
  @Published var message: String?
  @Published var pendingHostID: String?
  private var pendingScheduledRun: (hostID: String, runID: String)?
  private var openingScheduledRun = false
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
  private var badgeTask: Task<Void, Never>?
  private var badgeRevisions: [String: Int] = [:]
  private var resumeTask: Task<Void, Never>?
  private var automaticConnections: [BackendConnection] = []
  func binding(_ connection: BackendConnection, kind: NotificationKind) -> NotificationBinding? {
    bindings[key(connection, kind)]
  }
  func refreshFailure(_ connection: BackendConnection, kind: NotificationKind) -> String? {
    refreshFailures[key(connection, kind)]
  }
  private func key(_ connection: BackendConnection, _ kind: NotificationKind) -> String {
    kind == .battery ? connection.scope : "\(connection.scope):\(kind.rawValue)"
  }
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
  func openPendingScheduledRun(in session: AppSession, store: ConnectionStore) async {
    guard !openingScheduledRun, let target = pendingScheduledRun,
      let active = store.active, knownHosts[active.scope] == target.hostID,
      session.authenticated, session.foreground, session.health.status == .online,
      session.connection?.id == active.id else { return }
    openingScheduledRun = true
    defer { openingScheduledRun = false }
    do {
      let run = try await session.withConnection(reportFailure: false) {
        try await ScheduledTasksService(api: $0).run(target.runID)
      }
      guard pendingScheduledRun?.runID == target.runID,
        store.active?.id == active.id, session.connection?.id == active.id,
        session.authenticated else { return }
      pendingScheduledRun = nil
      session.openScheduledSource(ScheduledTaskSource(type: "scheduled-task", taskId: run.taskId, runId: run.id))
    } catch {
      guard pendingScheduledRun?.runID == target.runID else { return }
      pendingScheduledRun = nil
      message = "无法打开此运行记录：\(displayError(error))"
    }
  }
  func enable(_ connection: BackendConnection, kind: NotificationKind = .battery) async throws {
    let scope = key(connection, kind)
    refreshFailures[scope] = nil
    guard validStorage else { throw AttachmentError("提醒设置无法读取") }
    let api = try await connection.client()
    let availability = try await api.notificationStatus()
    guard availability.available else { throw AttachmentError(availability.reason ?? "推送暂不可用") }
    if kind != .battery, availability.supportedKinds?.contains(kind) != true {
      throw AttachmentError("此电脑版本尚不支持该提醒，请先更新 Backend")
    }
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
    if bindings[scope]?.pendingRevoke == true {
      await disable(connection, kind: kind, client: api)
      guard bindings[scope]?.pendingRevoke != true else {
        throw AttachmentError("远端提醒关闭尚未确认")
      }
    }
    let version = (versions[scope] ?? 0) + 1
    versions[scope] = version
    let token = try await registrationToken()
    guard versions[scope] == version else { throw CancellationError() }
    bindings[scope] = NotificationBinding(
      connection: connection, kind: kind, enabled: true, pendingRevoke: false)
    try persist()
    do {
      let response = try await api.registerNotifications(
        installation: installation, token: token,
        environment: environment, name: connection.name, explicit: kind == .battery, kind: kind)
      guard versions[scope] == version, bindings[scope]?.enabled == true
      else {
        try? await directRevoke(response)
        return
      }
      bindings[scope]?.subscription = response
      knownHosts[connection.scope] = response.hostId
      try persist()
      if response.revokeToken != nil, UIApplication.shared.applicationState != .background {
        let confirmed = try await api.confirmNotifications(response)
        if versions[scope] == version, bindings[scope]?.enabled == true {
          bindings[scope]?.subscription = confirmed
          try persist()
        }
      }
      if response.state == "disabled" {
        bindings[scope]?.enabled = false
        try persist()
      }
    } catch {
      // A lost response can still have created a binding. Retain a revocation intent.
      await disable(connection, kind: kind, client: api)
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
  func disable(
    _ connection: BackendConnection, kind: NotificationKind? = nil,
    client supplied: APIClient? = nil, reportFailure: Bool = true
  ) async {
    for selected in kind.map({ [$0] }) ?? NotificationKind.allCases {
      await disableOne(connection, kind: selected, client: supplied, reportFailure: reportFailure)
    }
  }
  private func disableOne(
    _ connection: BackendConnection, kind: NotificationKind,
    client supplied: APIClient?, reportFailure: Bool
  ) async {
    let scope = key(connection, kind)
    guard var binding = bindings[scope] else { return }
    refreshFailures[scope] = nil
    versions[scope, default: 0] += 1
    binding.enabled = false
    binding.pendingRevoke = true
    bindings[scope] = binding
    do { try persist() } catch {
      message = "关闭提醒状态保存失败"
      return
    }
    var revoked = false
    let resolved = supplied != nil ? supplied : (try? await connection.client())
    if let api = resolved {
      do {
        try await api.revokeNotifications(installation: installation, kind: kind)
        revoked = true
      } catch {}
    }
    // Backend returns 204 only after gateway revocation is confirmed; use the saved gateway
    // as a fallback when the Backend cannot confirm, not as a second required success.
    if !revoked, let subscription = binding.subscription, subscription.revokeToken != nil {
      do {
        try await directRevoke(subscription)
        revoked = true
      } catch { revoked = false }
    }
    if revoked {
      bindings[scope]?.pendingRevoke = false
      bindings[scope]?.subscription = nil
      do { try persist() } catch { message = "关闭提醒状态保存失败" }
    } else if reportFailure {
      message = "\(connection.name)：远端提醒关闭尚未确认"
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
    badgeTask?.cancel()
    badgeTask = nil
    resumeTask?.cancel()
    resumeTask = nil
  }
  func foreground(connections: [BackendConnection]) {
    automaticConnections = connections
    badgeTask?.cancel()
    badgeTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshBadge()
        do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
      }
    }
    tokenConfirmed = false
    if bindings.values.contains(where: { $0.enabled }), environment != nil {
      UIApplication.shared.registerForRemoteNotifications()
    }
    resumeTask?.cancel()
    resumeTask = Task { await refreshEnabled() }
  }
  func refreshAutomaticTasks(connections: [BackendConnection]) {
    automaticConnections = connections
    Task { await refreshEnabled() }
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
      await disable(binding.connection, kind: binding.kind ?? .battery, reportFailure: false)
    }
    if tokenConfirmed, let deviceToken, let environment {
      for binding in Array(bindings.values) where binding.enabled && !binding.pendingRevoke {
        guard !Task.isCancelled, UIApplication.shared.applicationState != .background else { return }
        let kind = binding.kind ?? .battery
        let scope = key(binding.connection, kind)
        let version = versions[scope] ?? 0
        guard
          let api = try? await binding.connection.client()
        else { continue }
        do {
          let result = try await api.registerNotifications(
            installation: installation, token: deviceToken,
            environment: environment, name: binding.connection.name, explicit: false, kind: kind)
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
            if versions[scope] ?? 0 == version {
              refreshFailures[scope] = nil
            }
          } else {
            try? await directRevoke(result)
          }
        } catch {
          // Automatic retries must not interrupt the user with a global alert on every foreground.
          // Keep failures on the affected connection, ignoring cancelled or superseded refreshes.
          if !Task.isCancelled, !(error is CancellationError),
            (error as? URLError)?.code != .cancelled,
            UIApplication.shared.applicationState != .background,
            versions[scope] ?? 0 == version, bindings[scope]?.enabled == true
          {
            refreshFailures[scope] = "提醒注册待更新：\(displayError(error))"
          }
        }
      }
    }
    for (connection, kind) in automaticConnections.flatMap({ connection in
      [NotificationKind.scheduledTask, .terminalUnread].map { (connection, $0) }
    }) {
      guard !Task.isCancelled, UIApplication.shared.applicationState != .background else { return }
      let scope = key(connection, kind)
      if bindings[scope]?.enabled == true || bindings[scope]?.pendingRevoke == true { continue }
      guard let api = try? await connection.client() else { continue }
      let authenticated = await api.hasCredentials()
      guard authenticated else { continue }
      do {
        try await enable(connection, kind: kind)
        refreshFailures[scope] = nil
      } catch {
        if !Task.isCancelled, UIApplication.shared.applicationState != .background {
          refreshFailures[scope] = "提醒注册待更新：\(displayError(error))"
        }
      }
    }
  }
  private func setBadge(_ count: Int) async throws {
    if #available(iOS 16.0, *) {
      try await UNUserNotificationCenter.current().setBadgeCount(count)
    } else {
      UIApplication.shared.applicationIconBadgeNumber = count
    }
  }

  private struct BadgeSnapshot: Decodable { let revision: Int; let count: Int }

  private func refreshBadge() async {
    let candidates = bindings.values.filter { $0.kind == .terminalUnread && $0.enabled && !$0.pendingRevoke }
    if candidates.isEmpty, bindings.values.contains(where: { $0.kind == .terminalUnread }),
      !bindings.values.contains(where: { $0.kind == .terminalUnread && $0.pendingRevoke }) {
      try? await setBadge(0)
      return
    }
    let gateways = Set(candidates.compactMap { $0.subscription?.gatewayURL })
    // The system has one badge per installation. Independent gateways cannot each own its total.
    guard gateways.count == 1 else { return }
    for binding in candidates {
      guard !Task.isCancelled, UIApplication.shared.applicationState != .background,
        let subscription = binding.subscription, subscription.state == "enabled",
        let raw = subscription.gatewayURL, let token = subscription.revokeToken,
        var url = URLComponents(string: raw), url.scheme == "https",
        url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
        url.path.isEmpty || url.path == "/" else { continue }
      url.path = "/v1/badges/\(subscription.subscriptionId)"
      guard let endpoint = url.url else { continue }
      var request = URLRequest(url: endpoint)
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.timeoutInterval = 5
      let network = URLSession(configuration: .ephemeral, delegate: NoPushRedirect(), delegateQueue: nil)
      defer { network.invalidateAndCancel() }
      do {
        let (data, response) = try await network.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { continue }
        let value = try JSONDecoder().decode(BadgeSnapshot.self, from: data)
        guard !Task.isCancelled, UIApplication.shared.applicationState != .background,
          bindings[key(binding.connection, .terminalUnread)]?.subscription?.subscriptionId == subscription.subscriptionId,
          bindings[key(binding.connection, .terminalUnread)]?.enabled == true,
          value.count >= 0, value.revision >= (badgeRevisions[raw] ?? 0) else { return }
        badgeRevisions[raw] = value.revision
        try await setBadge(value.count)
        return
      } catch { /* Keep the last count while offline. */ }
    }
  }

  public func acceptsBadge(_ info: [AnyHashable: Any]) -> Bool {
    guard info["category"] as? String == "terminal.unread",
      let host = info["hostId"] as? String, let revision = info["badgeRevision"] as? Int,
      let binding = bindings.values.first(where: {
        $0.kind == .terminalUnread && $0.enabled && !$0.pendingRevoke && $0.subscription?.hostId == host
      }), let gateway = binding.subscription?.gatewayURL,
      revision >= (badgeRevisions[gateway] ?? 0) else { return false }
    badgeRevisions[gateway] = revision
    return true
  }

  public func received(_ info: [AnyHashable: Any], tapped: Bool) -> Bool {
    guard let push = BatteryPush(info) else { return false }
    if tapped {
      if let runID = push.scheduledRunID { pendingScheduledRun = (push.hostID, runID) }
      pendingHostID = push.hostID
    }
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
