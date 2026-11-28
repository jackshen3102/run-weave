import Foundation

extension AppSession {
  func openScheduledSource(_ source: ScheduledTaskSource) {
    guard source.type == "scheduled-task" else { return }
    scheduledSource = source
    // Replace the Home terminal destination in place; do not race a pop with a second push.
    showingScheduledTasks = true
    closeTerminal()
  }

  func openNotificationTerminal(_ id: String, panelID: String?, focusPanel: Bool = true) async {
    guard authenticated, foreground, health.status == .online else { return }
    let epoch = generation
    var focused = false
    if focusPanel, canWrite, let api, let panelID, !panelID.isEmpty {
      do {
        try await api.focusTerminalPanel(terminalID: id, panelID: panelID)
        _ = await reload()
        focused = true
      } catch APIError.http(404), APIError.http(409) {
        _ = await reload()
      } catch {}
    }
    guard generation == epoch, authenticated, foreground, health.status == .online else { return }
    if terminal?.id != id || focused {
      await openTerminal(id)
    } else {
      showingScheduledTasks = false
      showingEnergyMonitor = false
      showingDevelopmentResources = false
      scheduledSource = nil
      browser.invalidate()
      clearBellMarker(id)
      await acknowledgeTerminal(id)
    }
  }
}
