import SwiftTerm
import UIKit

/// The renderer owns no network or credentials. All parser and UIKit calls stay on the main actor.
@MainActor
public final class SwiftTermSurface: NSObject, TerminalSurface, TerminalViewDelegate {
  public let terminalView: TerminalView
  public var view: UIView { terminalView }
  public var rawInput: (([UInt8]) -> Void)?
  public var viewportChanged: ((Int, Int) -> Void)?
  public var bell: (() -> Void)?
  public var scrollState: ((Double) -> Void)?
  public private(set) var renderer = "CoreGraphics"
  public private(set) var consumedBytes = 0
  private var active = true
  private var gestures: TerminalGestures?
  var isTmux: (() -> Bool)?
  var tmuxScroll: ((String, Int) -> Bool)?
  private var lastSize: (Int, Int)?
  private var pendingSize: (Int, Int)?
  private var sizeScheduled = false
  private var displayUpdateLink: AnyObject?
  private var displayBytes = 0
  private var displayCommit: ((Int, TimeInterval) -> Void)?
  public private(set) var eventDispatchStartedAt: TimeInterval?

  /// Opt-in measurement for the internal Profile probe. Does not force frames or flush transactions.
  @discardableResult
  public func observeDisplayCommits(_ callback: ((Int, TimeInterval) -> Void)?) -> Bool {
    guard #available(iOS 18.0, *) else { return false }
    (displayUpdateLink as? UIUpdateLink)?.isEnabled = false
    displayUpdateLink = nil
    displayCommit = nil
    eventDispatchStartedAt = nil
    terminalView.notifyUpdateChanges = false
    guard let callback else { return true }
    guard renderer == "CoreGraphics" else { return false }
    displayBytes = consumedBytes
    displayCommit = callback
    terminalView.notifyUpdateChanges = true
    let link = UIUpdateLink(view: terminalView)
    link.addAction(to: .beforeEventDispatch) { [weak self] _, _ in
      self?.eventDispatchStartedAt = ProcessInfo.processInfo.systemUptime
    }
    link.addAction(to: .afterCATransactionCommit) { [weak self] _, _ in
      guard let self, self.active, self.view.window != nil else { return }
      self.displayCommit?(self.displayBytes, ProcessInfo.processInfo.systemUptime)
    }
    link.isEnabled = true
    displayUpdateLink = link
    return true
  }

  public init(scrollback: Int = 5000) {
    var options = TerminalOptions.default
    options.scrollback = scrollback
    options.regionalIndicatorWidth = .narrow
    options.kittyImageCacheLimitBytes = 16 * 1024 * 1024
    terminalView = NativeTerminalView(
      frame: .zero,
      font: .monospacedSystemFont(ofSize: 14, weight: .regular),
      options: options)
    super.init()
    terminalView.terminalDelegate = self
    // Selection menus still need first-responder status, but reading the terminal
    // must not open a keyboard (and resize the remote screen). Input lives in Composer.
    terminalView.inputView = UIView(frame: .zero)
    terminalView.inputAccessoryView = nil
    if let view = terminalView as? NativeTerminalView {
      view.acceptsTerminalResponses = { [weak self] in self?.isTmux?() != true }
      let gestures = TerminalGestures(view: view)
      gestures.isTmux = { [weak self] in self?.isTmux?() ?? false }
      gestures.sendScroll = { [weak self] input, rows in self?.tmuxScroll?(input, rows) ?? false }
      self.gestures = gestures
    }
    applyTheme(dark: UserDefaults.standard.string(forKey: "native.theme") != "light")
    terminalView.accessibilityIdentifier = "native-terminal"
  }

  public func reset() {
    // SwiftTerm 1.19's RIS preserves the alternate buffer. Enter then leave it
    // to clear it before resetting; CAN first cancels any partial control string.
    terminalView.getTerminal().feed(text: "\u{18}\u{1b}[?1049h\u{1b}[?1049l\u{1b}c")
    terminalView.setNeedsDisplay()
    consumedBytes = 0
    displayBytes = 0
  }

  func applyTheme(dark: Bool) {
    terminalView.nativeBackgroundColor = TerminalAppearance.backgroundColor(dark: dark)
    terminalView.nativeForegroundColor = dark ? .white : .black
  }

  public func feed(_ bytes: [UInt8]) {
    guard active else { return }
    terminalView.feed(byteArray: bytes[...])
    consumedBytes += bytes.count
  }

  public func setActive(_ active: Bool) {
    self.active = active
    gestures?.active = active
    if !active { terminalView.resignFirstResponder() }
  }

  public func setMetal(_ enabled: Bool) throws {
    try terminalView.setUseMetal(enabled)
    renderer = enabled ? "Metal" : "CoreGraphics"
  }

  public func dispose() {
    observeDisplayCommits(nil)
    setActive(false)
    gestures?.dispose()
    gestures = nil
    isTmux = nil
    tmuxScroll = nil
    terminalView.terminalDelegate = nil
    rawInput = nil
    viewportChanged = nil
    bell = nil
    scrollState = nil
  }

  public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    guard active, newCols > 0, newRows > 0 else { return }
    pendingSize = (newCols, newRows)
    guard !sizeScheduled else { return }
    sizeScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.sizeScheduled = false
      guard self.active, let next = self.pendingSize else { return }
      if let previous = self.lastSize, previous == next { return }
      self.lastSize = next
      self.viewportChanged?(next.0, next.1)
    }
  }

  public func send(source: TerminalView, data: ArraySlice<UInt8>) {
    if active { rawInput?(Array(data)) }
  }
  public func scrolled(source: TerminalView, position: Double) { scrollState?(position) }
  public func bell(source: TerminalView) { bell?() }
  public func setTerminalTitle(source: TerminalView, title: String) {}
  public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  public func clipboardCopy(source: TerminalView, content: Data) {}
  public func clipboardRead(source: TerminalView) -> Data? { nil }
  public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
    // SwiftTerm invalidates the visible rows after this callback; UIKit commits that display later.
    displayBytes = consumedBytes
  }
}
