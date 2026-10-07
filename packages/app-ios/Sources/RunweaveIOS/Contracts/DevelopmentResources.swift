import Foundation

struct DevelopmentResourcesSnapshot: Decodable {
  let protocolVersion: Int
  let observedAt: String
  let hostId: String
  let hostName: String
  let backendGeneration: String
  let desktop: DevelopmentResourceGroup
  let simulators: DevelopmentResourceGroup

  var resources: [DevelopmentResource] {
    desktop.resources + (desktop.sessions ?? []) + simulators.resources
  }
}

struct DevelopmentResourceGroup: Decodable {
  let sourceState: String
  let reason: String?
  let resources: [DevelopmentResource]
  let sessions: [DevelopmentResource]?
  let counts: Counts

  struct Counts: Decodable {
    let total: Int?
    let busy: Int?
    let free: Int?
    let blocked: Int?
    let unknown: Int?
    var occupied: Int? {
      guard let busy, let blocked else { return nil }
      return busy + blocked
    }
    var attention: Int? {
      guard let blocked, let unknown else { return nil }
      return blocked + unknown
    }
  }
}

struct DevelopmentResource: Decodable, Identifiable {
  let id: String
  let kind: String
  let label: String
  let state: String
  let owner: Owner?
  let ownershipVersion: String?
  let details: Details
  let release: Release
  let operation: Operation?
  let reason: String?

  struct Owner: Decodable {
    let id: String
    let task: String?
    let worktree: String?
    let startedAt: String?
    let lastActivityAt: String?
  }
  struct Details: Decodable {
    let path: String?
    let udid: String?
    let deviceState: String?
    let ports: [Int]
    let processes: [Process]
  }
  struct Process: Decodable {
    let name: String
    let pid: Int
    let ownership: String
    let cpuPercent: Double?
    let rssBytes: Double?
  }
  struct Release: Decodable {
    let action: String?
    let disabledReason: String?
  }
  struct Operation: Decodable {
    let id: String
    let state: String
  }
  var isAttention: Bool { state == "blocked" || state == "unknown" || operation?.state == "unknown" }
  var actionLabel: String { release.action == "release-occupancy" ? "释放占用" : "停止并释放" }
  var canRelease: Bool {
    owner != nil && ownershipVersion != nil && operation == nil
      && (state == "busy" || state == "blocked")
      && ["stop-and-release", "release-occupancy"].contains(release.action ?? "")
  }
}

struct DevelopmentResourceReleaseResult: Decodable {
  let operationId: String
  let state: String
  let message: String
}

struct DevelopmentResourceFailure: Decodable, Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

func developmentResourceDate(_ value: String?) -> Date? {
  guard let value else { return nil }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
