import RunweaveBrowser
import SwiftTerm
import UIKit

/// Local history uses UIScrollView; alternate screens route through TerminalGestures.
@MainActor
final class NativeTerminalView: TerminalView {
  weak var scrollHandler: TerminalGestures?
  var acceptsTerminalResponses: () -> Bool = { true }
  var linkIntent: ((BrowserOpenIntent) -> Void)?
  private var menuObserver: NSObjectProtocol?
  private var linkMenu: AnyObject?
  private var menuPoint = CGPoint.zero

  override func mouseModeChanged(source: Terminal) {
    // Runweave owns remote scrolling. SwiftTerm's mouse pan would compete with
    // UIScrollView even though allowMouseReporting is disabled.
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === panGestureRecognizer {
      guard scrollHandler?.active != false, !hasActiveSelection else { return false }
      let start = gestureRecognizer.location(in: self).x
        - panGestureRecognizer.translation(in: self).x - bounds.minX
      guard start > 24 else { return false }
    }
    return super.gestureRecognizerShouldBegin(gestureRecognizer)
  }

  func installLinkMenu() {
    // Observe SwiftTerm's own recognizer after its hit testing. Do not install a competing pan
    // or maintain a second ANSI/cell map. Long press selects via SwiftTerm's public API.
    for recognizer in gestureRecognizers ?? [] where recognizer is UILongPressGestureRecognizer {
      recognizer.addTarget(self, action: #selector(selectLinkAtLongPress(_:)))
    }
    if #available(iOS 16.0, *) {
      let menu = UIEditMenuInteraction(delegate: self)
      addInteraction(menu)
      linkMenu = menu
    }
    menuObserver = NotificationCenter.default.addObserver(
      forName: UIMenuController.willShowMenuNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        DispatchQueue.main.async { [weak self] in
          self?.observeSelectionPans()
          self?.presentSelectedLinkMenu()
        }
      }
    }
  }

  func disposeLinkMenu() {
    if let menuObserver { NotificationCenter.default.removeObserver(menuObserver) }
    menuObserver = nil
    if #available(iOS 16.0, *), let menu = linkMenu as? UIEditMenuInteraction {
      menu.dismissMenu()
      removeInteraction(menu)
    }
    linkMenu = nil
    for recognizer in gestureRecognizers ?? [] {
      recognizer.removeTarget(self, action: #selector(selectLinkAtLongPress(_:)))
      recognizer.removeTarget(self, action: #selector(selectionPanEnded(_:)))
    }
    if isFirstResponder { UIMenuController.shared.hideMenu() }
    linkIntent = nil
  }

  @objc private func selectLinkAtLongPress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began, !hasActiveSelection, linkIntent != nil else { return }
    menuPoint = gesture.location(in: self)
    // Target invocation order is not an API guarantee. Wait for SwiftTerm to capture its
    // bidi-aware buffer position before asking it to select; never derive our own hit map.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.linkIntent != nil, !self.hasActiveSelection else { return }
      self.select(nil)
      self.observeSelectionPans()
      // SwiftTerm may show its legacy menu before this asynchronous selection exists.
      // Re-evaluate after selection rather than relying on an already-delivered notification.
      self.presentSelectedLinkMenu()
    }
  }

  private func observeSelectionPans() {
    guard linkIntent != nil else { return }
    // SwiftTerm installs its selection pan dynamically. Observe it without adding a competing
    // recognizer or retaining removed pans; remove/add keeps our target registration unique.
    for recognizer in gestureRecognizers ?? [] where recognizer is UIPanGestureRecognizer {
      recognizer.removeTarget(self, action: #selector(selectionPanEnded(_:)))
      recognizer.addTarget(self, action: #selector(selectionPanEnded(_:)))
    }
  }

  @objc private func selectionPanEnded(_ gesture: UIPanGestureRecognizer) {
    guard gesture.state == .ended, linkIntent != nil else { return }
    // Updating an already visible legacy menu need not emit another willShow notification.
    // Wait until SwiftTerm has finished extending the selection and updating its own menu.
    DispatchQueue.main.async { [weak self] in
      self?.presentSelectedLinkMenu()
    }
  }

  private func presentSelectedLinkMenu() {
    guard isFirstResponder, selectedLink != nil else { return }
    if #available(iOS 16.0, *), let menu = linkMenu as? UIEditMenuInteraction {
      UIMenuController.shared.hideMenu()
      menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: menuPoint))
    }
  }

  private var selectedLink: String? {
    guard linkIntent != nil, let text = getSelection(), !text.isEmpty,
      !text.contains(where: { $0.isNewline }) else { return nil }
    let terminal = getTerminal()
    let start = selection.start
    let end = selection.end
    if let explicit = terminal.link(at: .buffer(start), mode: .explicitOnly) {
      guard end.row >= start.row, end.row - start.row <= 100 else { return nil }
      // Only treat a selection entirely covered by one OSC 8 target as a hyperlink label.
      for row in start.row...end.row {
        let first = row == start.row ? start.col : 0
        let last = row == end.row ? end.col : terminal.cols
        guard first <= last else { return nil }
        for col in first..<last {
          guard terminal.link(at: .buffer(Position(col: col, row: row)), mode: .explicitOnly) == explicit else { return nil }
        }
      }
      return explicit
    }
    return TerminalLinkSelection.selectedURL(text)
  }

  fileprivate func linkActions() -> [UIMenuElement] {
    guard let target = selectedLink else { return [] }
    let host: String
    if let url = URL(string: target), let actualHost = url.host { host = actualHost }
    else { host = "不支持的链接" }
    let actions: [(String, BrowserOpenIntent.Action)] = [
      ("内置打开 · \(host)", .internalOpen), ("链接 · \(host)", .link)
    ]
    return actions.map { title, action in
      UIAction(title: title) { [weak self] _ in
        guard let self, self.selectedLink == target else { return }
        self.linkIntent?(BrowserOpenIntent(target: target, origin: .selection, action: action))
      }
    }
  }

  override func send(source: Terminal, data: ArraySlice<UInt8>) {
    // Parser replies are distinct from TerminalView.send(data:) keyboard input.
    // The tmux transport routes input to the pane, not to its attach client's PTY.
    guard acceptsTerminalResponses() else { return }
    super.send(source: source, data: data)
  }

  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    switch direction {
    case .up, .previous:
      return scrollHandler?.scroll(rows: getTerminal().rows) ?? super.accessibilityScroll(direction)
    case .down, .next:
      return scrollHandler?.scroll(rows: -getTerminal().rows)
        ?? super.accessibilityScroll(direction)
    default: return super.accessibilityScroll(direction)
    }
  }
}

@available(iOS 16.0, *)
extension NativeTerminalView: UIEditMenuInteractionDelegate {
  func editMenuInteraction(_ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
    UIMenu(children: suggestedActions + linkActions())
  }
}

@MainActor
final class TerminalGestures: NSObject, UIGestureRecognizerDelegate {
  private weak var view: NativeTerminalView?
  private let pan = UIPanGestureRecognizer()
  private var accumulated: CGFloat = 0
  // Runweave's private tmux server uses the default copy-mode wheel bindings (-N 5).
  private let tmuxRowsPerWheel = 5
  var active = true {
    didSet {
      view?.isScrollEnabled = active
      pan.isEnabled = active
      accumulated = 0
    }
  }
  var isTmux: () -> Bool = { false }
  var sendScroll: ((String, Int) -> Bool)?

  init(view: NativeTerminalView) {
    self.view = view
    super.init()
    view.scrollHandler = self
    view.allowMouseReporting = false
    pan.maximumNumberOfTouches = 1
    pan.addTarget(self, action: #selector(drag(_:)))
    pan.delegate = self
    view.addGestureRecognizer(pan)
  }

  // SwiftTerm installs new mouse/selection pans as terminal modes change.
  // Resolve priority per recognition attempt so late recognizers also wait for scrolling.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    otherGestureRecognizer.view === view && otherGestureRecognizer is UIPanGestureRecognizer
  }
  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard active, let view, !view.hasActiveSelection else { return false }
    // Normal-buffer history already has pixel scrolling and native inertia.
    guard view.getTerminal().isCurrentBufferAlternate else { return false }
    let position = pan.location(in: view)
    let start = position.x - pan.translation(in: view).x - view.bounds.minX
    let velocity = pan.velocity(in: view)
    // Leave the leading edge and horizontal navigation gestures to the host.
    return start > 24 && abs(velocity.y) > abs(velocity.x)
  }
  @objc private func drag(_ gesture: UIPanGestureRecognizer) {
    guard let view else { return }
    if gesture.state == .began { accumulated = 0 }
    if gesture.state == .began || gesture.state == .changed {
      guard active, !view.hasActiveSelection, view.getTerminal().isCurrentBufferAlternate,
        isTmux() else { accumulated = 0; return }
      accumulated += gesture.translation(in: view).y * 2
      gesture.setTranslation(.zero, in: view)
      let lineHeight = view.getOptimalFrameSize().height / CGFloat(max(1, view.getTerminal().rows))
      guard lineHeight > 0 else { return }
      let wheels = Int(accumulated / (lineHeight * CGFloat(tmuxRowsPerWheel)))
      if wheels != 0 {
        accumulated -= CGFloat(wheels * tmuxRowsPerWheel) * lineHeight
        _ = sendTmuxScroll(wheels: wheels)
      }
    } else {
      accumulated = 0
    }
  }
  @discardableResult func scroll(rows: Int) -> Bool {
    guard active, let view, !view.hasActiveSelection, rows != 0 else { return false }
    let terminal = view.getTerminal()
    if terminal.isCurrentBufferAlternate, isTmux() {
      // VoiceOver requests a page, measured in rows rather than wheel events.
      let wheels = max(1, Int((Double(abs(rows)) / Double(tmuxRowsPerWheel)).rounded()))
      return sendTmuxScroll(wheels: rows > 0 ? wheels : -wheels)
    }
    // Unlike pageUp/pageDown, scrollUp/Down never emit cursor keys in a PTY alternate screen.
    if rows > 0 { view.scrollUp(lines: rows) } else { view.scrollDown(lines: -rows) }
    return true
  }
  private func sendTmuxScroll(wheels: Int) -> Bool {
    guard let view else { return false }
    let terminal = view.getTerminal()
    let button = wheels > 0 ? 64 : 65
    let col = max(1, terminal.cols / 2)
    let row = max(1, terminal.rows / 2)
    let input = String(repeating: "\u{1b}[<\(button);\(col);\(row)M", count: abs(wheels))
    return sendScroll?(input, wheels * tmuxRowsPerWheel) ?? false
  }
  func dispose() {
    if let view {
      view.removeGestureRecognizer(pan)
      view.scrollHandler = nil
    }
    sendScroll = nil
    view = nil
  }
}
