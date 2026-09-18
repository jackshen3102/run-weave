import Foundation

// Mirrors @runweave/shared/browser-local-tunnel, protocol version 1.
struct BrowserLocalCapabilities: Decodable {
  let protocolVersion: Int
  let maxConnections: Int
  let maxFrameBytes: Int
}
struct BrowserLocalOpen: Encodable {
  let type = "open"
  let version = 1
  let terminalSessionId: String
  let browserSessionId: String
  let host: String
  let port: Int
  let secure: Bool
}
struct BrowserLocalControl: Decodable {
  let type: String
  let code: String?
}
