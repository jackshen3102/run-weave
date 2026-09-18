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
      return try await BrowserLocalTransport(api: api, target: target, terminalID: terminal.id).prepare()
    }
  }

  var browserSource: BrowserContext? {
    guard authenticated, let connection, let terminal, terminalController != nil else { return nil }
    return BrowserContext(scope: [connection.scope, terminal.id], generation: String(generation))
  }
}
