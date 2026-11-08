import SwiftUI
import Clarity
import QuickLook

struct TerminalCodeReviewStrip: View {
  @ObservedObject var model: TerminalCodeReviewModel
  @ObservedObject var session: AppSession
  var body: some View {
    VStack(spacing: 0) { if model.statusVisible {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(model.writing ? "准备审查" : model.actionFailure ?? model.latest?.status ?? "")
            .font(.caption).lineLimit(2)
          Spacer(minLength: 0)
          if model.latest != nil { Button("查看报告") { model.showingReport = true }.font(.caption) }
          if let id = model.latest?.reviewerTerminalId { Button("评审终端") { Task { await session.openTerminal(id) } }.font(.caption) }
          if model.canDismissStatus {
            Button(action: model.dismissStatus) { Image(systemName: "xmark").padding(6) }
              .accessibilityLabel("结束审查事项").accessibilityIdentifier("code-review-status-dismiss")
          }
        }
        if let error = model.latest?.deliveryError { Text(error).font(.caption2).foregroundStyle(.secondary) }
        if model.failure != nil && model.latest != nil { Text("显示上次状态，刷新失败").font(.caption2) }
      }.padding(.horizontal, 12).padding(.vertical, 6)
        .background(TerminalAppearance.background).accessibilityIdentifier("code-review-status")
    } }
    .task(id: "\(session.generation):\(session.foreground):\(session.authenticated):\(session.health.status)") {
      if model.canRead { await model.poll() } else { model.suspend() }
    }.onDisappear { model.suspend() }
      .sheet(isPresented: $model.showingReport) {
        if let run = model.latest { TerminalCodeReviewView(model: model, reviewID: run.reviewId) }
      }
  }
}

struct TerminalMonitoringStrips: View {
  @ObservedObject var codeReview: TerminalCodeReviewModel
  @ObservedObject var supervision: TaskSupervisionModel
  @ObservedObject var session: AppSession
  let controller: SessionController
  @Binding var showingSupervision: Bool
  var body: some View {
    TerminalCodeReviewStrip(model: codeReview, session: session)
    if let watch = supervision.watch, watch.enabled {
      TaskSupervisionStrip(watch: watch, stale: !supervision.canRead || supervision.failure != nil) {
        controller.surface.view.window?.endEditing(true)
        showingSupervision = true
      }
    }
  }
}

struct TerminalCodeReviewView: View {
  @ObservedObject var model: TerminalCodeReviewModel
  let reviewID: String
  @Environment(\.dismiss) private var dismiss
  @State private var selectedReviewID: String?
  private var activeReviewID: String { selectedReviewID ?? reviewID }
  @State private var detail: TerminalCodeReviewDetail?
  @State private var failure: String?
  @State private var preview: URL?
  @State private var artifacts: [URL] = []
  var body: some View {
    NavigationView {
      List {
        if let runs = model.page?.runs, runs.count > 1 {
          Section {
            Menu("本终端最近的报告") {
              ForEach(runs) { run in
                Button("\(run.createdAt) · \(run.status)") { detail = nil; failure = nil; selectedReviewID = run.reviewId }
              }
            }
          }
        }
        if let failure { Text(failure).foregroundColor(.red) }
        if let detail {
          Section {
            Text(detail.run.status)
            Text(detail.run.createdAt).font(.caption).foregroundStyle(.secondary)
            if let round = detail.run.round { Text("第 \(round) 轮审查").font(.caption).foregroundStyle(.secondary) }
            if detail.run.stale { Text("审查期间代码已变化，结论仅对应原快照。").foregroundColor(.orange) }
            if let fingerprint = detail.snapshot?.fingerprint { Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled) }
          }
          if let report = detail.report {
            Section("结论") {
              Text(report.summary).textSelection(.enabled)
              Text(report.coverageComplete ? "已声明覆盖完整，仍需核对证据" : "覆盖存在缺口")
            }
            Section("问题（\(report.findings.count)）") {
              ForEach(Array(report.findings.enumerated()), id: \.offset) { _, finding in
                VStack(alignment: .leading, spacing: 6) {
                  Text("\(finding.severity) · \(finding.title)").font(.headline)
                  Text("\(finding.path):\(finding.lineStart)–\(finding.lineEnd) · \(finding.changeKind)/\(finding.side) · \(finding.basis)").font(.caption)
                  Text(finding.impact).textSelection(.enabled)
                  evidence(finding.evidenceRefs, report: report)
                }
              }
            }
            Section("验证") {
              ForEach(Array(report.checks.enumerated()), id: \.offset) { _, check in
                VStack(alignment: .leading, spacing: 6) {
                  Text("\(check.description) · \(check.status)")
                  Text(check.environment).font(.caption).foregroundStyle(.secondary)
                  Text(check.observedResult).textSelection(.enabled)
                  evidence(check.evidenceRefs, report: report)
                }
              }
            }
            Section("覆盖与清理") {
              ForEach(Array(report.limitations.enumerated()), id: \.offset) { _, text in Text(text) }
              Text(report.cleanup)
              DisclosureGroup("受审文件（\(report.reviewedChanges.count)）") {
                ForEach(Array(report.reviewedChanges.enumerated()), id: \.offset) { _, entry in Text("\(entry.changeKind) · \(entry.path)").font(.caption) }
              }
            }
          } else {
            Text("报告尚未完成")
            ForEach(Array((detail.snapshot?.omissions ?? []).enumerated()), id: \.offset) { _, text in Text(text) }
          }
          Text("Review 只评审代码，不表示符合原对话需求或可发布，不自动授予修复、提交和外部操作权限。").font(.caption).foregroundStyle(.secondary)
        } else if failure == nil { ProgressView("读取报告…") }
      }.navigationTitle("代码 Review").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } } }
        .refreshable { await load() }
    }.task(id: "\(activeReviewID):\(model.canRead)") {
      while model.canRead && !Task.isCancelled {
        await load()
        if let run = detail?.run, !run.active && !["pending", "writing"].contains(run.delivery) { break }
        do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { break }
      }
    }.quickLookPreview($preview)
      .onDisappear { for url in artifacts { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
      .clarityMask().accessibilityIdentifier("code-review-report")
  }
  @ViewBuilder private func evidence(_ ids: [String], report: TerminalCodeReviewReport) -> some View {
    ForEach(ids, id: \.self) { id in
      if let artifact = report.artifacts.first(where: { $0.artifactId == id }) {
        Button("证据：\(id)") {
          Task {
            do { let url = try await model.artifact(reviewID: activeReviewID, artifact: artifact); artifacts.append(url); preview = url }
            catch { if !(error is CancellationError) { failure = displayError(error) } }
          }
        }
      }
    }
  }
  private func load() async {
    do { detail = try await model.detail(activeReviewID); failure = nil }
    catch { if !(error is CancellationError) { failure = displayError(error) } }
  }
}
