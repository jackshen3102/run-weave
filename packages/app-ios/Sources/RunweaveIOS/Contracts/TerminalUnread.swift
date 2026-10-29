import Foundation

/// Mirrors @runweave/shared/terminal-unread; does not require push subscriptions.
struct TerminalUnreadSnapshot: Decodable {
  let hostId: String
  let revision: Int
  let count: Int
}

extension APIClient {
  func terminalUnread() async throws -> TerminalUnreadSnapshot {
    try await authorized("/api/terminal/unread", requestTimeout: 5)
  }
}
