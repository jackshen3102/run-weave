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
    if let view = terminalView as? NativeTerminalView {
      let gestures = TerminalGestures(view: view)
      gestures.isTmux = { [weak self] in self?.isTmux?() ?? false }
      gestures.sendScroll = { [weak self] input, rows in self?.tmuxScroll?(input, rows) ?? false }
      self.gestures = gestures
    }
    applyTheme(dark: UserDefaults.standard.string(forKey: "native.theme") != "light")
    terminalView.accessibilityIdentifier = "native-terminal"
  }

  public func reset() {
    terminalView.getTerminal().resetToInitialState()
    terminalView.setNeedsDisplay()
    consumedBytes = 0
  }

  func applyTheme(dark: Bool) {
    terminalView.nativeBackgroundColor = dark ? .black : .white
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
  public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
