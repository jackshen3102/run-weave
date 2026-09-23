import Foundation

struct HomeBranchStatusResponse: Decodable {
  let statuses: [HomeBranchStatus]
}

/// Mirrors AppHomeBranchStatus in @runweave/shared/terminal/session.
struct HomeBranchStatus: Decodable {
  let terminalSessionId: String
  let cwd: String
  var state: String
  let baseBranch: String?
  let behind: Int?
  let checkedAt: String?

  var checkedDate: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return checkedAt.flatMap { formatter.date(from: $0) }
  }
}
