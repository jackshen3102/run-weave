import Foundation
import Combine
import SwiftUI

@MainActor
final class HomeBranchStatusModel: ObservableObject {
  @Published private var values: [String: HomeBranchStatus] = [:]
  private var attempted: [String: Date] = [:]
  private var inFlight = Set<String>()
  private var generation: Int?

  func status(for terminal: HomeTerminal, generation: Int, online: Bool) -> HomeBranchStatus? {
    guard self.generation == generation, var value = values[terminal.id],
      value.cwd == terminal.cwd else { return nil }
    if value.state == "ready" {
      let checked = value.checkedDate ?? .distantPast
      if !online || Date().timeIntervalSince(checked) >= 600 { value.state = "stale" }
    }
    return value
  }

  func refresh(session: AppSession, terminals: [HomeTerminal], force: Bool = false) async {
    let epoch = session.generation
    if generation != epoch {
      generation = epoch
      values = [:]
      attempted = [:]
      inFlight = []
    }
    guard session.authenticated, session.foreground, session.terminal == nil, session.health.status == .online,
      let api = session.api, !Task.isCancelled else { return }
    let candidates = terminals.filter { terminal in
      !inFlight.contains(terminal.id) && (force || values[terminal.id]?.cwd != terminal.cwd
        || Date().timeIntervalSince(attempted[terminal.id] ?? .distantPast) >= 600)
    }
    // Bound each HTTP request, including unusually large attention lists.
    for start in stride(from: 0, to: candidates.count, by: 4) {
      guard !Task.isCancelled, session.generation == epoch, session.foreground, session.terminal == nil else { return }
      let batch = Array(candidates[start..<min(start + 4, candidates.count)])
      let ids = Set(batch.map(\.id))
      inFlight.formUnion(ids)
      do {
        let response = try await api.homeBranchStatuses(ids: Array(ids), refresh: force)
        guard !Task.isCancelled, session.generation == epoch, generation == epoch else {
          if generation == epoch { inFlight.subtract(ids) }
          return
        }
        for terminal in batch {
          if let value = response.statuses.first(where: {
            $0.terminalSessionId == terminal.id && $0.cwd == terminal.cwd
          }) {
            values[terminal.id] = value
            attempted[terminal.id] = value.state == "ready" ? (value.checkedDate ?? Date()) : Date()
          } else {
            values[terminal.id] = HomeBranchStatus(terminalSessionId: terminal.id,
              cwd: terminal.cwd, state: "unavailable", baseBranch: nil, behind: nil, checkedAt: nil)
            attempted[terminal.id] = Date()
          }
        }
      } catch {
        guard !Task.isCancelled, session.generation == epoch, generation == epoch else {
          if generation == epoch { inFlight.subtract(ids) }
          return
        }
        for terminal in batch {
          if var value = values[terminal.id], value.cwd == terminal.cwd {
            value.state = value.behind == nil ? "unavailable" : "stale"
            values[terminal.id] = value
          } else {
            values[terminal.id] = HomeBranchStatus(terminalSessionId: terminal.id,
              cwd: terminal.cwd, state: "unavailable", baseBranch: nil, behind: nil, checkedAt: nil)
          }
          attempted[terminal.id] = Date()
        }
      }
      if generation == epoch { inFlight.subtract(ids) }
    }
    let retained = Set(terminals.map(\.id))
    values = values.filter { retained.contains($0.key) }
    attempted = attempted.filter { retained.contains($0.key) }
  }
}

struct HomeBranchStatusLabel: View {
  let status: HomeBranchStatus

  var body: some View {
    if status.state != "not-repository" {
      HStack(spacing: 3) {
        if let base = status.baseBranch, let behind = status.behind {
          Text(base).lineLimit(1).truncationMode(.middle)
          Text(behind > 0 ? "↓\(behind)" : "✓").monospacedDigit().fixedSize()
        }
        if status.state != "ready" { Text("待更新").fixedSize() }
      }
      .foregroundColor(status.state != "ready" ? .secondary : (status.behind ?? 0) > 0 ? .orange : .secondary)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityText)
    }
  }

  private var accessibilityText: String {
    guard let base = status.baseBranch, let behind = status.behind else { return "分支状态待更新" }
    let comparison = behind > 0 ? "落后 \(base) \(behind) 次提交" : "与 \(base) 无落差"
    return comparison + (status.state == "ready" ? "" : "，待更新")
  }
}
