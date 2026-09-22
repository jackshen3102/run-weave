import Foundation

public struct BuildIdentity: Codable, Sendable {
  public let schemaVersion: Int
  public let fingerprintVersion: Int
  public let buildId: String
  public let appId: String
  public let bundleId: String
  public let sourceRevision: String?
  public let sourceState: String
  public let inputsSHA256: String
  public let builtAt: String
  public let configuration: String
  public let platform: String
  public let architecture: String
  public let xcodeVersion: String
  public let sdkVersion: String
}

public enum AppBuildIdentity {
  public enum ReadError: LocalizedError {
    case missing, invalid
    public var errorDescription: String? {
      switch self {
      case .missing: return "此安装包没有构建信息，请重新构建安装。"
      case .invalid: return "此安装包的构建信息无效，请重新构建安装。"
      }
    }
  }

  // Read only on explicit inspection. No startup work, network, events or persistent store.
  public static func read() throws -> (identity: BuildIdentity, data: Data) {
    guard let url = Bundle.main.url(forResource: "BuildIdentity", withExtension: "json") else {
      throw ReadError.missing
    }
    guard let data = try? Data(contentsOf: url), data.count < 32 * 1024,
      let value = try? JSONDecoder().decode(BuildIdentity.self, from: data),
      value.schemaVersion == 1, value.fingerprintVersion == 1,
      UUID(uuidString: value.buildId) != nil, value.bundleId == Bundle.main.bundleIdentifier,
      ["runweave", "suiji"].contains(value.appId),
      value.inputsSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      throw ReadError.invalid
    }
    return (value, data)
  }
}
