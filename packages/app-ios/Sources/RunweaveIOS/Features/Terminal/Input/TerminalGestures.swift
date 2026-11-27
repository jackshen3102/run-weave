import RunweaveBrowser
import SwiftTerm
import UIKit

/// Local history uses UIScrollView; alternate screens route through TerminalGestures.
@MainActor
final class NativeTerminalView: TerminalView {
  weak var scrollHandler: TerminalGestures?
  var acceptsTerminalResponses: () -> Bool = { true }
  var linkIntent: ((BrowserOpenIntent) -> Void)?
  var onTouchBegan: (() -> Void)?
  var onScrollPositionChanged: ((CGFloat, CGFloat, Bool, Bool) -> Void)?
  private var menuObserver: NSObjectProtocol?
  private var selectionMenu: AnyObject?
  private var menuPoint = CGPoint.zero

  override var contentOffset: CGPoint {
    didSet {
      notifyScrollPositionChanged()
    }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    onTouchBegan?()
    scrollHandler?.cancelScroll()
    super.touchesBegan(touches, with: event)
  }

  private func notifyScrollPositionChanged() {
    guard let callback = onScrollPositionChanged else { return }
    let maxOffset = max(0, contentSize.height - bounds.height + adjustedContentInset.bottom)
    callback(contentOffset.y, maxOffset, isTracking, isDecelerating)
  }

  @objc private func nativePanDidUpdate(_ gesture: UIPanGestureRecognizer) {
    if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
      DispatchQueue.main.async { [weak self] in
        self?.notifyScrollPositionChanged()
      }
    }
  }

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

  func installSelectionMenu() {
    panGestureRecognizer.removeTarget(self, action: #selector(nativePanDidUpdate(_:)))
    panGestureRecognizer.addTarget(self, action: #selector(nativePanDidUpdate(_:)))
    // Observe SwiftTerm's own recognizer after its hit testing. Do not install a competing pan
    // or maintain a second ANSI/cell map. Long press selects via SwiftTerm's public API.
    for recognizer in gestureRecognizers ?? [] where recognizer is UILongPressGestureRecognizer {
      recognizer.addTarget(self, action: #selector(selectAtLongPress(_:)))
    }
    for case let recognizer as UITapGestureRecognizer in gestureRecognizers ?? []
      where recognizer.numberOfTapsRequired > 1 {
      recognizer.addTarget(self, action: #selector(selectionTapped(_:)))
    }
    if #available(iOS 16.0, *) {
      let menu = UIEditMenuInteraction(delegate: self)
      addInteraction(menu)
      selectionMenu = menu
    }
    menuObserver = NotificationCenter.default.addObserver(
      forName: UIMenuController.willShowMenuNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        DispatchQueue.main.async { [weak self] in
          self?.observeSelectionPans()
          self?.presentSelectionMenu()
        }
      }
    }
  }

  func disposeSelectionMenu() {
    if let menuObserver { NotificationCenter.default.removeObserver(menuObserver) }
    menuObserver = nil
    if #available(iOS 16.0, *), let menu = selectionMenu as? UIEditMenuInteraction {
      menu.dismissMenu()
      removeInteraction(menu)
    }
    selectionMenu = nil
    for recognizer in gestureRecognizers ?? [] {
      recognizer.removeTarget(self, action: #selector(selectAtLongPress(_:)))
      recognizer.removeTarget(self, action: #selector(selectionPanEnded(_:)))
      recognizer.removeTarget(self, action: #selector(selectionTapped(_:)))
      recognizer.removeTarget(self, action: #selector(nativePanDidUpdate(_:)))
    }
    if isFirstResponder { UIMenuController.shared.hideMenu() }
    linkIntent = nil
    onTouchBegan = nil
    onScrollPositionChanged = nil
  }

  @objc private func selectAtLongPress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began, !hasActiveSelection, menuObserver != nil else { return }
    menuPoint = gesture.location(in: self)
    // Target invocation order is not an API guarantee. Wait for SwiftTerm to capture its
    // bidi-aware buffer position before asking it to select; never derive our own hit map.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.menuObserver != nil, !self.hasActiveSelection else { return }
      self.select(nil)
      self.observeSelectionPans()
      // SwiftTerm may show its legacy menu before this asynchronous selection exists.
      // Re-evaluate after selection rather than relying on an already-delivered notification.
      self.presentSelectionMenu()
    }
  }

  @objc private func selectionTapped(_ gesture: UITapGestureRecognizer) {
    if gesture.state == .ended { menuPoint = gesture.location(in: self) }
  }

  private func observeSelectionPans() {
    guard menuObserver != nil else { return }
    // SwiftTerm installs its selection pan dynamically. Observe it without adding a competing
    // recognizer or retaining removed pans; remove/add keeps our target registration unique.
    for recognizer in gestureRecognizers ?? [] where recognizer is UIPanGestureRecognizer {
      recognizer.removeTarget(self, action: #selector(selectionPanEnded(_:)))
      recognizer.addTarget(self, action: #selector(selectionPanEnded(_:)))
    }
  }

  @objc private func selectionPanEnded(_ gesture: UIPanGestureRecognizer) {
    guard gesture.state == .ended, hasActiveSelection, menuObserver != nil else { return }
    menuPoint = gesture.location(in: self)
    // Updating an already visible legacy menu need not emit another willShow notification.
    // Wait until SwiftTerm has finished extending the selection and updating its own menu.
    DispatchQueue.main.async { [weak self] in
      self?.presentSelectionMenu()
    }
  }

  private func presentSelectionMenu() {
    guard menuObserver != nil, isFirstResponder, hasActiveSelection else { return }
    if #available(iOS 16.0, *), let menu = selectionMenu as? UIEditMenuInteraction {
      UIMenuController.shared.hideMenu()
      let point = CGPoint(x: min(max(menuPoint.x, bounds.minX), bounds.maxX),
        y: min(max(menuPoint.y, bounds.minY), bounds.maxY))
      menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    } else {
      UIMenuController.shared.update()
    }
  }

  override func selectionChanged(source: Terminal) {
    super.selectionChanged(source: source)
    // SwiftTerm dismisses its legacy menu when selection is cleared. Keep our
    // menu in the same lifecycle, including copy, cancelled drags and new output.
    if !hasActiveSelection, #available(iOS 16.0, *),
      let menu = selectionMenu as? UIEditMenuInteraction {
      menu.dismissMenu()
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
    guard hasActiveSelection else { return nil }
    // suggestedActions can reflect the menu opened before the asynchronous
    // long-press selection. Build Copy from the actual terminal selection instead.
    let copy = UIAction(title: "复制", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
      guard let self, self.hasActiveSelection else { return }
      self.copy(nil)
    }
    let paste = UIAction(title: "粘贴") { [weak self] _ in self?.paste(nil) }
    let selectAll = UIAction(title: "全选") { [weak self] _ in
      guard let self else { return }
      self.selectAll(nil)
      DispatchQueue.main.async { [weak self] in self?.presentSelectionMenu() }
    }
    return UIMenu(children: [copy, paste, selectAll] + linkActions())
  }
}

@MainActor
final class TerminalGestures: NSObject, UIGestureRecognizerDelegate {
  private weak var view: NativeTerminalView?
  private let pan = UIPanGestureRecognizer()
  private var accumulated: CGFloat = 0
  private var gestureID = UUID().uuidString
  private var cancelled = false
  private var momentum: CADisplayLink?
  private var momentumVelocity: CGFloat = 0
  private var lastMomentumTime: CFTimeInterval = 0
  var usesNormalizedScroll: () -> Bool = { false }
  var normalizedScrollUsesHistory: () -> Bool = { false }
  var scrollSensitivity: () -> CGFloat = { 1 }
  var sendNormalizedScroll: ((String, Int, String) -> Bool)?
  var stopNormalizedScroll: ((String) -> Void)?
  var canUseLocalHistoryScroll: () -> Bool = { false }
  var beginLocalHistoryScroll: ((CGFloat) -> Bool)?
  var updateLocalHistoryScroll: ((CGFloat) -> Void)?
  var endLocalHistoryScroll: ((CGFloat) -> Void)?
  private var localHistoryHandoffActive = false
  private var localHistoryGestureMultiplier: CGFloat = 1
  // Runweave's private tmux server uses the default copy-mode wheel bindings (-N 5).
  private let tmuxRowsPerWheel = 5
  var active = true {
    didSet {
      view?.isScrollEnabled = active
      cancelScroll()
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
    guard let view, !view.hasActiveSelection else { return false }
    let localReady = isTmux() && canUseLocalHistoryScroll()
    guard active || localReady else { return false }
    // Normal-buffer history already has pixel scrolling and native inertia.
    guard view.getTerminal().isCurrentBufferAlternate || (isTmux() && (usesNormalizedScroll() || localReady)) else { return false }
    let position = pan.location(in: view)
    let start = position.x - pan.translation(in: view).x - view.bounds.minX
    let velocity = pan.velocity(in: view)
    // Leave the leading edge and horizontal navigation gestures to the host.
    return start > 24 && abs(velocity.y) > abs(velocity.x)
  }
  func cancelScroll() {
    momentum?.invalidate()
    momentum = nil
    momentumVelocity = 0
    accumulated = 0
    cancelled = true
    localHistoryHandoffActive = false
    localHistoryGestureMultiplier = 1
    if usesNormalizedScroll() { stopNormalizedScroll?(gestureID) }
  }

  func applyScrollState(_ state: TerminalScrollState) {
    if state.gestureId == gestureID && state.status == "cancelled" {
      momentum?.invalidate()
      momentum = nil
      accumulated = 0
      cancelled = true
    }
  }

  private func move(_ points: CGFloat, phase: String) {
    guard active, !cancelled, let view, view.window != nil, !view.hasActiveSelection, isTmux() else { return }
    let lineHeight = view.getOptimalFrameSize().height / CGFloat(max(1, view.getTerminal().rows))
    guard lineHeight > 0 else { return }
    if points.sign != accumulated.sign { accumulated = 0 }
    // Preserve the existing history drag gain; application wheels use their own distance.
    let distanceScale: CGFloat = !usesNormalizedScroll() || normalizedScrollUsesHistory() ? 2 : 1
    accumulated += points * distanceScale * scrollSensitivity()
    let unit = lineHeight * CGFloat(usesNormalizedScroll() ? 1 : tmuxRowsPerWheel)
    let steps = Int(accumulated / unit)
    guard steps != 0 else { return }
    accumulated -= CGFloat(steps) * unit
    let accepted = usesNormalizedScroll()
      ? (sendNormalizedScroll?(gestureID, steps, phase) ?? false)
      : sendTmuxScroll(wheels: steps)
    if !accepted { cancelScroll() }
  }

  @objc private func drag(_ gesture: UIPanGestureRecognizer) {
    guard let view else { return }
    if gesture.state == .began {
      cancelScroll()
      gestureID = UUID().uuidString
      cancelled = false
      localHistoryHandoffActive = false
      localHistoryGestureMultiplier = 1
    }
    if gesture.state == .began || gesture.state == .changed || gesture.state == .ended {
      let dy = gesture.translation(in: view).y
      gesture.setTranslation(.zero, in: view)
      if localHistoryHandoffActive {
        updateLocalHistoryScroll?(dy * localHistoryGestureMultiplier)
      } else if canUseLocalHistoryScroll() {
        let multiplier: CGFloat = dy < 0 ? -1 : 1
        if abs(dy) > 0, beginLocalHistoryScroll?(abs(dy)) == true {
          localHistoryGestureMultiplier = multiplier
          localHistoryHandoffActive = true
        }
      } else {
        move(dy, phase: "direct")
      }
    }
    if gesture.state == .ended {
      if localHistoryHandoffActive {
        let multiplier = localHistoryGestureMultiplier
        localHistoryHandoffActive = false
        localHistoryGestureMultiplier = 1
        endLocalHistoryScroll?(gesture.velocity(in: view).y * multiplier)
        return
      }
      if usesNormalizedScroll(), !cancelled, !canUseLocalHistoryScroll() {
        let velocity = gesture.velocity(in: view).y
        if abs(velocity) >= 80 {
          momentumVelocity = min(max(velocity, -view.bounds.height * 4), view.bounds.height * 4)
          lastMomentumTime = 0
          let link = CADisplayLink(target: self, selector: #selector(decelerate(_:)))
          momentum = link
          link.add(to: .main, forMode: .common)
        }
      }
    } else if gesture.state == .cancelled || gesture.state == .failed {
      if localHistoryHandoffActive {
        localHistoryHandoffActive = false
        localHistoryGestureMultiplier = 1
        endLocalHistoryScroll?(0)
      }
      cancelScroll()
    }
  }

  @objc private func decelerate(_ link: CADisplayLink) {
    guard active, !cancelled, let view, view.window != nil, !view.hasActiveSelection, usesNormalizedScroll() else {
      cancelScroll(); return
    }
    let elapsed = lastMomentumTime == 0 ? link.duration : min(0.05, link.timestamp - lastMomentumTime)
    lastMomentumTime = link.timestamp
    let decay = pow(Double(UIScrollView.DecelerationRate.normal.rawValue), elapsed * 1000)
    let previousVelocity = momentumVelocity
    momentumVelocity *= CGFloat(decay)
    move((previousVelocity + momentumVelocity) * CGFloat(elapsed) / 2, phase: "momentum")
    if abs(momentumVelocity) < 20 {
      momentum?.invalidate()
      momentum = nil
      accumulated = 0
    }
  }
  @discardableResult func scroll(rows: Int) -> Bool {
    guard active, let view, !view.hasActiveSelection, rows != 0 else { return false }
    let terminal = view.getTerminal()
    if rows > 0, isTmux(), canUseLocalHistoryScroll() {
      let lineHeight = max(1, view.getOptimalFrameSize().height / CGFloat(max(1, terminal.rows)))
      if beginLocalHistoryScroll?(CGFloat(rows) * lineHeight) == true {
        endLocalHistoryScroll?(0)
        return true
      }
    }
    if isTmux(), usesNormalizedScroll() {
      cancelScroll()
      gestureID = UUID().uuidString
      cancelled = false
      return sendNormalizedScroll?(gestureID, rows, "direct") ?? false
    }
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
    cancelScroll()
    sendNormalizedScroll = nil
    stopNormalizedScroll = nil
    canUseLocalHistoryScroll = { false }
    beginLocalHistoryScroll = nil
    updateLocalHistoryScroll = nil
    endLocalHistoryScroll = nil
    if let view {
      view.removeGestureRecognizer(pan)
      view.scrollHandler = nil
    }
    sendScroll = nil
    view = nil
  }
}
