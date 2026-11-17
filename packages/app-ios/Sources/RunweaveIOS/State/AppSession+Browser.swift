import Foundation
import RunweaveBrowser

@MainActor
extension AppSession {
  func configureBrowser() {
    browser.currentSource = { [weak self] in self?.browserSource }
    browser.prepareLocalPreview = { [weak self] target, source in
      guard let self, self.browserSource == source, let api = self.api, let terminal = self.terminal else {
        throw CancellationError()
      }
      let generation = self.generation
      let current = { [weak self] in
        self?.generation == generation && self?.browserSource == source
      }
      let preview = try await BrowserLocalTransport(
        api: api, target: target, terminalID: terminal.id, isCurrent: current).prepare()
      guard current() else { preview.close(); throw CancellationError() }
      return preview
    }
  }

  var browserSource: BrowserContext? {
    guard authenticated, let connection, let terminal, terminalController != nil else { return nil }
    return BrowserContext(scope: [connection.scope, terminal.id], generation: browserGeneration.uuidString)
  }
}
