import Foundation
import CryptoKit
import Darwin

public struct CaptureIdentity: Codable, Equatable, Sendable {
  public let environment: ConnectionEnvironment
  public let endpoint: String
  public let serverId: String
  public let ownerId: String
  public init(environment: ConnectionEnvironment, endpoint: String, serverId: String, ownerId: String) {
    self.environment = environment; self.endpoint = endpoint; self.serverId = serverId; self.ownerId = ownerId
  }
  var key: String { SharedCaptureStore.hash(environment.rawValue + "\n" + endpoint + "\n" + serverId + "\n" + ownerId) }
}
public struct CaptureConnection: Codable, Equatable, Sendable {
  public let identity: CaptureIdentity
  public let generation: String
  public let materials: Bool
  public init(identity: CaptureIdentity, materials: Bool) {
    self.identity = identity; self.materials = materials; generation = UUID().uuidString
  }
}
public enum SharedCaptureStore {
  public static func root() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SuijiAppGroup") as? String,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
      throw CaptureError("共享存储不可用，请检查随记 App Group 签名")
    }
    var url = root.appendingPathComponent("Captures", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
    return url
  }
  static func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
  static func write<T: Encodable>(_ value: T, to url: URL) throws {
    try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  public static func connection() throws -> CaptureConnection? {
    let url = try root().appendingPathComponent("connection.json")
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(CaptureConnection.self, from: Data(contentsOf: url))
  }
  @MainActor public static func setConnection(_ value: CaptureConnection?, ifCurrent: () -> Bool = { true }) async throws {
    let lock = try await CaptureFileLock.acquire("connection")
    defer { withExtendedLifetime(lock) {} }
    guard ifCurrent() else { return }
    let url = try root().appendingPathComponent("connection.json")
    if let value { try write(value, to: url) }
    else if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }
  public static func assertCurrent(_ value: CaptureConnection) throws {
    guard try connection() == value else { throw CaptureError("连接已切换，请回到随记确认原账号；素材仍属于原账号") }
  }
}

/// The inode is never unlinked: process death releases flock without stealing a live lock.
final class CaptureFileLock: @unchecked Sendable {
  private let fd: Int32
  private init(fd: Int32) { self.fd = fd }
  deinit { flock(fd, LOCK_UN); close(fd) }
  static func acquire(_ name: String, timeout: TimeInterval = 5) async throws -> CaptureFileLock {
    let url = try SharedCaptureStore.root().appendingPathComponent("lock-" + SharedCaptureStore.hash(name))
    let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw CaptureError("无法锁定共享保存状态") }
    let until = Date().addingTimeInterval(timeout)
    do {
      while flock(fd, LOCK_EX | LOCK_NB) != 0 {
        guard errno == EWOULDBLOCK, Date() < until else { throw CaptureError("另一进程正在保存，请稍后手动重试") }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      return CaptureFileLock(fd: fd)
    } catch { close(fd); throw error }
  }
}
