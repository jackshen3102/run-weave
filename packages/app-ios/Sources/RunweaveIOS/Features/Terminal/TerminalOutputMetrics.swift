import SwiftUI

/// Only diagnostic consumers observe transport accounting; it never invalidates session UI.
@MainActor
public final class TerminalOutputMetrics: ObservableObject {
  @Published public fileprivate(set) var receivedBytes = 0
  @Published public fileprivate(set) var queuedBytes = 0
  func addReceived(_ count: Int) { receivedBytes += count }
  func addQueued(_ count: Int) { queuedBytes += count }
  func clearQueued() { queuedBytes = 0 }
}

