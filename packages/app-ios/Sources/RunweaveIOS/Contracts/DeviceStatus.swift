import Foundation

struct DeviceStatusSnapshot: Decodable {
  let protocolVersion: Int
  let hostId: String
  let streamId: String
  let revision: Int
  let sampleStatus: String
  let observedAt: String?
  let sampleAgeMs: Double?
  let battery: Battery
  struct Battery: Decodable {
    let presence: String
    let percent: Int?
    let powerSource: String
    let chargeState: String
    let remainingMinutes: Int?
  }
}

extension APIClient {
  func deviceStatus() async throws -> DeviceStatusSnapshot {
    try await authorized("/api/device/status")
  }
}
