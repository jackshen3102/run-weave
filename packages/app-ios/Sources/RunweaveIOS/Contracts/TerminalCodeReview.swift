import Foundation

struct TerminalCodeReviewRun: Decodable, Identifiable {
  struct Failure: Decodable { let code: String; let message: String }
  let reviewId: String
  let requestId: String
  let projectId: String
  let phase: String
  let createdAt: String
  let updatedAt: String
  let reviewerTerminalId: String?
  let reviewerPanelId: String?
  let reportId: String?
  let stale: Bool
  let delivery: String
  let error: Failure?
  let deliveryError: String?
  let summary: String?
  let findingCount: Int?
  var id: String { reviewId }
  var active: Bool { ["preparing", "starting", "reviewing"].contains(phase) }
  var status: String {
    if let error { return error.message }
    if phase == "completed" {
      let label = ["pending": "等待回传", "writing": "正在回传", "written": "已回传", "unavailable": "仅展示报告", "target_changed": "来源已变化", "unknown": "回传未确认"][delivery] ?? ""
      return "审查完成 · \(findingCount ?? 0) 个问题 · \(label)" + (stale ? " · 代码已变化" : "")
    }
    return ["preparing": "准备审查", "starting": "启动审查终端", "reviewing": "正在审查", "blocked": "审查已阻塞", "failed": "审查失败", "cancelled": "审查已中断"][phase] ?? phase
  }
}
struct TerminalCodeReviewPage: Decodable {
  let runs: [TerminalCodeReviewRun]
  let before: String?
}
struct TerminalCodeReviewReport: Decodable {
  struct Finding: Decodable {
    let severity: String; let title: String; let path: String; let changeKind: String
    let side: String; let lineStart: Int; let lineEnd: Int; let impact: String
    let basis: String; let evidenceRefs: [String]
  }
  struct Check: Decodable {
    let description: String; let status: String; let environment: String
    let observedResult: String; let evidenceRefs: [String]
    let beforeFingerprint: String?; let afterFingerprint: String?
  }
  struct Change: Decodable { let path: String; let changeKind: String }
  struct Artifact: Decodable { let artifactId: String; let path: String; let mimeType: String }
  let schemaVersion: Int
  let reviewId: String; let snapshotId: String; let fingerprint: String; let summary: String
  let findings: [Finding]; let checks: [Check]; let reviewedChanges: [Change]
  let limitations: [String]; let coverageComplete: Bool; let cleanup: String
  let artifacts: [Artifact]
}
struct TerminalCodeReviewDetail: Decodable {
  struct Snapshot: Decodable {
    let schemaVersion: Int; let snapshotId: String; let head: String?; let rootPath: String
    let fingerprint: String; let capturedAt: String; let omissions: [String]
  }
  let run: TerminalCodeReviewRun
  let snapshot: Snapshot?
  let report: TerminalCodeReviewReport?
}
