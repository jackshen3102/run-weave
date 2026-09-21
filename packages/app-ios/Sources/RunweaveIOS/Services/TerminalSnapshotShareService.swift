import Foundation

extension APIClient {
  func createTerminalSnapshotShare(id: String) async throws -> TerminalSnapshotShare {
    // iOS displays the tmux session. Resolve its current active panel at click time,
    // then explicitly pin that panel for capture instead of using stale entry details.
    let path = "/api/terminal/session/\(Self.pathComponent(id))/panels"
    let workspace: SnapshotPanelWorkspace = try await authorized(path)
    guard workspace.terminalSessionId == id, !workspace.activePanelId.isEmpty,
      workspace.panels.contains(where: { $0.panelId == workspace.activePanelId })
    else { throw APIError.invalidResponse }
    try Task.checkCancellation()
    let response: TerminalSnapshotShareResponse = try await authorized(
      "\(path)/\(Self.pathComponent(workspace.activePanelId))/shares",
      method: "POST", retryUnauthorized: false)
    return TerminalSnapshotShare(url: try response.resolveURL())
  }
}

// Projection of packages/shared/src/terminal/panel.ts TerminalPanelWorkspace.
private struct SnapshotPanelWorkspace: Decodable {
  let terminalSessionId: String
  let activePanelId: String
  let panels: [Panel]
  struct Panel: Decodable { let panelId: String }
}
