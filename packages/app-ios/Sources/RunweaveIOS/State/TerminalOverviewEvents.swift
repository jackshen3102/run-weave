/// Event categories that invalidate or refresh the terminal overview.
enum TerminalOverviewEvents {
  static let structural = Set([
    "project_created", "project_deleted", "terminal_session_created", "terminal_session_deleted",
  ])
  static let refresh = structural.union([
    "completion", "completion_acknowledged", "terminal_state_changed", "terminal_session_metadata_changed",
    "terminal_panel_created", "terminal_panel_updated", "terminal_panel_deleted", "terminal_panel_focused",
  ])
}
