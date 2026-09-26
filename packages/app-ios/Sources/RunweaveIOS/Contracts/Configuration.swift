import Foundation

// Mirrors packages/shared/src/configuration; private fields never enter this DTO.
struct ConfigurationSnapshot: Decodable {
  struct Identity: Codable, Equatable { let kind: String; let instanceId: String }
  struct Field: Decodable, Identifiable {
    let path: String; let type: String; let domain: String
    let sensitive: Bool; let apply: String; let description: String
    var id: String { path }
  }
  struct Consumer: Decodable {
    let appliedRevision: Int?; let state: String
    var label: String {
      switch state {
      case "applied": return "已生效"
      case "restartRequired": return "等待所属服务重启"
      case "unconfigured": return "未配置"
      default: return "配置错误"
      }
    }
  }
  struct DiskError: Decodable { let code: String }
  let environment: Identity
  let savedRevision: Int?
  let digest: String?
  let diskError: DiskError?
  let fields: [Field]
  let values: [String: ConfigurationValue]
  let consumers: [String: Consumer]
}

indirect enum ConfigurationValue: Decodable {
  case string(String), number(Double), bool(Bool), array([ConfigurationValue]), object([String: ConfigurationValue]), null
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode([ConfigurationValue].self) { self = .array(value) }
    else { self = .object(try container.decode([String: ConfigurationValue].self)) }
  }
  var json: Any {
    switch self {
    case .string(let value): return value
    case .number(let value): return value
    case .bool(let value): return value
    case .array(let value): return value.map(\.json)
    case .object(let value): return value.mapValues(\.json)
    case .null: return NSNull()
    }
  }
  var text: String {
    if case .string(let value) = self { return value }
    if case .null = self { return "" }
    return (try? JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
}
