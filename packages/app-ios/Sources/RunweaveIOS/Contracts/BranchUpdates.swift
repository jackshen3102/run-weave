import Foundation

let branchUpdatesLimit = 10
func branchUpdatesCountLabel(_ count: Int) -> String {
  count >= branchUpdatesLimit ? "最近 \(branchUpdatesLimit) 条" : "\(count) 条"
}

/// Mirrors @runweave/shared/terminal/branch-updates; the list never contains a total count.
struct BranchUpdateCommit: Decodable, Identifiable {
  let oid: String
  let subject: String
  let authorName: String
  let committedAt: String
  var id: String { oid }
}

struct BranchUpdatesSnapshot: Decodable {
  let headOid: String
  let currentBranch: String?
  let baseRemote: String
  let baseBranch: String
  let baseOid: String
  let checkedAt: String
  let items: [BranchUpdateCommit]
}

struct BranchUpdatesResponse: Decodable {
  struct Target: Decodable {
    let kind: String
    let terminalSessionId: String?
    let cwd: String?
  }
  let target: Target
  let state: String
  let snapshot: BranchUpdatesSnapshot?
  let reason: String?
}
