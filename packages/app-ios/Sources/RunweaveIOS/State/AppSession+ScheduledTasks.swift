import Foundation

extension AppSession {
  func openScheduledSource(_ source: ScheduledTaskSource) {
    guard source.type == "scheduled-task" else { return }
    scheduledSource = source
    // Replace the Home terminal destination in place; do not race a pop with a second push.
    showingScheduledTasks = true
    closeTerminal()
  }
}
