import Foundation

struct PrWatchCandidate: Decodable {
  let repoNameWithOwner, prUrl, prTitle: String
  let prNumber: Int
}

struct TerminalPrWatchState: Decodable {
  let watchId, terminalSessionId, panelId: String
  let threadId, threadProvider: String?
  let repoNameWithOwner, prUrl, prTitle, status: String
  let prNumber, commentWakeCount, consecutiveReadFailures, revision: Int
  let pauseReason, headSha, lastCheckedAt, lastWakeAt, lastSummary: String?

  var statusTitle: String {
    ["watching": "值守中", "paused": "已暂停", "settled": "已结束", "error": "请检查投递"][status] ?? status
  }
}

struct PrWatchResponse: Decodable {
  let watch: TerminalPrWatchState?
  let candidatePr: PrWatchCandidate?
  let inputVersion: String?
}
