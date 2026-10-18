import Foundation

/// A bounded check that never cancels the socket or its caller's HTTP requests.
@MainActor
final class WebSocketLiveness {
  private var continuation: CheckedContinuation<Bool, Never>?
  private var timeout: Task<Void, Never>?

  static func check(_ socket: URLSessionWebSocketTask) async -> Bool {
    await WebSocketLiveness().run(socket)
  }

  private func run(_ socket: URLSessionWebSocketTask) async -> Bool {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        guard !Task.isCancelled else { continuation.resume(returning: false); return }
        self.continuation = continuation
        timeout = Task { [weak self] in
          do { try await Task.sleep(nanoseconds: 2_500_000_000) } catch { return }
          self?.finish(false)
        }
        socket.sendPing { [weak self] error in
          Task { @MainActor in self?.finish(error == nil) }
        }
      }
    } onCancel: {
      Task { @MainActor in self.finish(false) }
    }
  }

  private func finish(_ responsive: Bool) {
    guard let continuation else { return }
    self.continuation = nil
    timeout?.cancel()
    timeout = nil
    continuation.resume(returning: responsive)
  }
}
