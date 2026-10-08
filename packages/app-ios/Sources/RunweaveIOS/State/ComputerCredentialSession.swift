import Foundation

/// One refresh owner per computer, shared by foreground and auxiliary clients.
actor ComputerCredentialSession {
  struct Snapshot { let tokens: AuthTokens?; let revision: Int }
  private static let registryLock = NSLock()
  private static var registry: [String: ComputerCredentialSession] = [:]
  nonisolated static func shared(account: String) throws -> ComputerCredentialSession {
    registryLock.lock()
    defer { registryLock.unlock() }
    if let existing = registry[account] { return existing }
    let value = try ComputerCredentialSession(account: account)
    registry[account] = value
    return value
  }

  private let account: String
  private let vault = CredentialStore()
  private var tokens: AuthTokens?
  private var revision = 0
  private var refreshTask: Task<AuthTokens, Error>?
  private var importing = false
  private var uncertain: Bool
  private var identity: ConnectionIdentity?

  private init(account: String) throws {
    self.account = account
    tokens = try vault.read(account).map { try JSONDecoder().decode(AuthTokens.self, from: $0) }
    identity = try vault.read(account + ".identity").map { try JSONDecoder().decode(ConnectionIdentity.self, from: $0) }
    uncertain = try vault.read(account + ".refresh-unknown") != nil
  }
  func snapshot() throws -> Snapshot {
    guard !importing else { throw CancellationError() }
    if uncertain { throw APIError.refreshResultUnknown }
    return Snapshot(tokens: tokens, revision: revision)
  }
  func hasCredentials() -> Bool { tokens != nil }
  func trust() -> ConnectionIdentity? { identity }
  func bind(_ value: ConnectionIdentity, replacing: Bool = false) throws {
    try value.validate()
    if let identity, identity != value, !replacing { throw ConnectionIdentityFailure.identityMismatch }
    try vault.write(JSONEncoder().encode(value), account: account + ".identity")
    identity = value
  }
  func settle() async { _ = await refreshTask?.result }
  func replace(_ next: AuthTokens) async throws {
    await settle()
    guard !importing else { throw CancellationError() }
    try save(next)
    revision += 1
  }
  private func save(_ next: AuthTokens) throws {
    guard !next.accessToken.isEmpty, !next.refreshToken.isEmpty else { throw APIError.invalidResponse }
    try vault.write(JSONEncoder().encode(next), account: account)
    tokens = next
    try vault.delete(account + ".refresh-unknown")
    uncertain = false
  }
  func clear() async throws {
    await settle()
    guard !importing else { throw CancellationError() }
    try vault.delete(account)
    try vault.delete(account + ".identity")
    try vault.delete(account + ".refresh-unknown")
    tokens = nil; identity = nil; uncertain = false; revision += 1
  }
  func refresh(expected: String, using operation: @escaping (String) async throws -> AuthTokens) async throws -> AuthTokens {
    guard !uncertain else { throw APIError.refreshResultUnknown }
    if let refreshTask { return try await refreshTask.value }
    guard !importing, let current = tokens else { throw APIError.credentialsUnavailable }
    if current.refreshToken != expected { return current }
    let task = Task<AuthTokens, Error> {
      do {
        var renewed = try await operation(current.refreshToken)
        renewed.expiresAt = Date().addingTimeInterval(renewed.expiresIn)
        try self.save(renewed)
        return renewed
      } catch is CancellationError {
        // The transport gate rejected the operation before an HTTP request was sent.
        throw CancellationError()
      } catch APIError.http(401) {
        try self.vault.delete(self.account)
        self.tokens = nil; self.revision += 1
        throw APIError.credentialsUnavailable
      } catch {
        // A missing response cannot establish that the rotating refresh was not consumed.
        self.uncertain = true
        try self.vault.write(Data([1]), account: self.account + ".refresh-unknown")
        throw APIError.refreshResultUnknown
      }
    }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value
  }
  func importLogin(_ next: AuthTokens, commit: @escaping @MainActor () throws -> Void) async throws {
    await settle()
    guard !importing else { throw CancellationError() }
    importing = true
    defer { importing = false }
    let account = self.account
    let encoded = try JSONEncoder().encode(next)
    try await MainActor.run {
      try Task.checkCancellation()
      let vault = CredentialStore()
      let previous = try vault.read(account)
      try vault.write(encoded, account: account)
      do { try commit() }
      catch {
        do {
          if let previous { try vault.write(previous, account: account) }
          else { try vault.delete(account) }
        } catch { throw MobileLoginFailure(message: "保存连接失败，原凭据恢复失败，请重新登录。") }
        throw error
      }
    }
    tokens = next; revision += 1
    try vault.delete(account + ".refresh-unknown")
    uncertain = false
  }
}

struct AuthTokens: Codable {
  let accessToken: String
  let refreshToken: String
  let expiresIn: Double
  let sessionId: String
  var expiresAt: Date?
}
