import Foundation
import SwiftUI

@MainActor
final class ConnectionRouteResolver: ObservableObject {
  private static var instances: [String: ConnectionRouteResolver] = [:]
  private static var foreground = true
  static func register(_ computer: BackendConnection) {
    if let resolver = instances[computer.id] { resolver.update(computer) }
    else { instances[computer.id] = ConnectionRouteResolver(computer) }
  }
  static func forComputer(_ computer: BackendConnection) -> ConnectionRouteResolver {
    // A persisted notification binding may contain an old snapshot; do not overwrite live config.
    if let value = instances[computer.id] { return value }
    let value = ConnectionRouteResolver(computer); instances[computer.id] = value
    return value
  }
  static func remove(_ id: String) {
    guard let value = instances.removeValue(forKey: id) else { return }
    value.cancel()
    if let client = value.client { Task { await client.close() } }
  }
  static func setForeground(_ value: Bool) {
    foreground = value
    if !value {
      for resolver in instances.values {
        resolver.cancel(); resolver.client?.suspendTransport(); resolver.needsValidation = true
      }
    }
  }

  @Published private(set) var computer: BackendConnection
  @Published private(set) var activeRouteID: String?
  @Published private(set) var checkingRouteID: String?
  @Published private(set) var statuses: [String: String] = [:]
  @Published private(set) var latency: Int?
  @Published private(set) var needsUpgrade = false
  private(set) var client: APIClient?
  private(set) var lastVerifiedURL: String?
  private var selection: Task<APIClient, Error>?
  private var revision = 0
  private var needsValidation = false
  var onInvalidated: (() -> Void)?
  var currentRoute: ConnectionRoute? { computer.routes.first { $0.id == activeRouteID } }

  private init(_ computer: BackendConnection) { self.computer = computer }
  private func update(_ next: BackendConnection) {
    guard computer != next else { return }
    let old = computer
    computer = next
    let activeChanged = client.map { api in
      !next.routes.contains(where: { $0.id == activeRouteID && $0.url == api.baseURL.absoluteString })
    } ?? false
    let modeChanged = old.automatic != next.automatic || old.fixedRouteID != next.fixedRouteID
    let fixesCurrent = !next.automatic && next.fixedRouteID == activeRouteID && !activeChanged
    if selection != nil || activeChanged || (modeChanged && !fixesCurrent) {
      client?.suspendTransport()
      cancel()
      onInvalidated?()
    }
  }
  func cancel() {
    revision += 1
    selection?.cancel(); selection = nil
    checkingRouteID = nil
  }
  func resolve(force: Bool = false) async throws -> APIClient {
    guard Self.foreground else { throw APIError.offline }
    if !force, let selection { return try await selection.value }
    if !force, let client, let route = currentRoute, route.url == client.baseURL.absoluteString,
      computer.automatic || computer.fixedRouteID == route.id {
      let cachedRevision = revision
      if !(await client.isClosed()) {
        try check(cachedRevision)
        guard needsValidation else { return client }
        let epoch = revision
        let validation = Task<APIClient, Error> { [self] in
          let health = try await proveCurrent(client, route: route)
          try check(epoch)
          client.resumeTransport(); needsValidation = false; latency = health.latencyMilliseconds
          return client
        }
        selection = validation
        defer { if revision == epoch { selection = nil } }
        return try await validation.value
      }
    }
    cancel()
    let epoch = revision
    let old = client
    old?.suspendTransport()
    if let activeRouteID { statuses[activeRouteID] = "已断开" }
    client = nil; activeRouteID = nil
    let snapshot = computer
    let task = Task<APIClient, Error> { [self] in
      // close waits for any rotating refresh response before destroying its transport.
      await old?.close()
      let candidates = snapshot.automatic ? snapshot.routes : snapshot.routes.filter { $0.id == snapshot.fixedRouteID }
      guard !candidates.isEmpty else { throw ConnectionIdentityFailure.selectRoute }
      let credentials = try ComputerCredentialSession.shared(account: snapshot.credentialAccount)
      var lastFailure: Error = APIError.offline
      for route in candidates {
        try check(epoch)
        checkingRouteID = route.id; statuses[route.id] = "正在检测…"
        let started = ProcessInfo.processInfo.systemUptime
        var candidate: APIClient?
        do {
          let base = try APIClient.normalize(route.url)
          if let trust = await credentials.trust() {
            try await ConnectionIdentityClient.verify(base: base, trust: trust)
          } else {
            // An arbitrary added URL can never bootstrap trust using an existing token.
            guard route.url == snapshot.bootstrapURL else { throw ConnectionIdentityFailure.unsupported }
            let health = await DeviceHealthService.check(base: base,
              connectionID: APIClient.diagnosticConnectionID(base: base, id: snapshot.id))
            guard health.status == .online else { throw RouteHealthFailure(message: health.message) }
          }
          try check(epoch)
          lastVerifiedURL = route.url
          let api = try APIClient(base: route.url, connectionID: snapshot.id, credentialAccount: snapshot.credentialAccount)
          candidate = api
          if await api.hasCredentials() {
            try await api.verify()
            if await credentials.trust() == nil {
              do { try await api.bootstrapIdentity() }
              catch APIError.http(503) { /* A damaged identity does not break the original route. */ }
              needsUpgrade = await credentials.trust() == nil
            }
          }
          try check(epoch)
          latency = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
          client = api; activeRouteID = route.id; checkingRouteID = nil; needsValidation = false
          statuses[route.id] = "当前使用"
          return api
        } catch {
          await candidate?.close()
          try check(epoch)
          statuses[route.id] = displayError(error)
          lastFailure = error
          if case APIError.credentialsUnavailable = error { throw error }
          if case APIError.refreshResultUnknown = error { throw error }
        }
      }
      throw lastFailure
    }
    selection = task
    defer { if revision == epoch { selection = nil; checkingRouteID = nil } }
    return try await task.value
  }
  private func check(_ epoch: Int) throws {
    guard revision == epoch, Self.foreground, !Task.isCancelled else { throw CancellationError() }
  }
  func validateCurrent() async throws -> DeviceHealthSnapshot {
    guard Self.foreground, let client, let route = currentRoute else { throw APIError.offline }
    if needsValidation {
      _ = try await resolve()
      return DeviceHealthSnapshot(status: .online, latencyMilliseconds: latency, message: "电脑在线")
    }
    let epoch = revision
    let health = try await proveCurrent(client, route: route)
    try check(epoch)
    return health
  }
  private func proveCurrent(_ client: APIClient, route: ConnectionRoute) async throws -> DeviceHealthSnapshot {
    let started = ProcessInfo.processInfo.systemUptime
    let credentials = try ComputerCredentialSession.shared(account: computer.credentialAccount)
    if let trust = await credentials.trust() {
      try await ConnectionIdentityClient.verify(base: client.baseURL, trust: trust)
      return DeviceHealthSnapshot(status: .online,
        latencyMilliseconds: Int((ProcessInfo.processInfo.systemUptime - started) * 1000), message: "电脑在线")
    }
    guard route.url == computer.bootstrapURL else { throw ConnectionIdentityFailure.unsupported }
    let health = await DeviceHealthService.check(base: client.baseURL, connectionID: client.connectionID)
    guard health.status == .online else { throw RouteHealthFailure(message: health.message) }
    return health
  }
}
private struct RouteHealthFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
