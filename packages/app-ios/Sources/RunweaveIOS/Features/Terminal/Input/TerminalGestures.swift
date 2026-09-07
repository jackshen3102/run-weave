import SwiftTerm
import UIKit

/// Uses the same scrolling path for touch and VoiceOver. No command parsing or input replay.
@MainActor
final class NativeTerminalView: TerminalView {
  weak var scrollHandler: TerminalGestures?
  var acceptsTerminalResponses: () -> Bool = { true }

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

@MainActor
final class TerminalGestures: NSObject, UIGestureRecognizerDelegate {
  private weak var view: NativeTerminalView?
  private let pan = UIPanGestureRecognizer()
  private var accumulated: CGFloat = 0
  var active = true
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
      accumulated += gesture.translation(in: view).y * 3
      gesture.setTranslation(.zero, in: view)
      let lineHeight = view.bounds.height / CGFloat(max(1, view.getTerminal().rows))
      guard lineHeight > 0 else { return }
      let rows = Int(accumulated / lineHeight)
      if rows != 0 {
        accumulated -= CGFloat(rows) * lineHeight
        _ = scroll(rows: rows)
      }
    } else {
      accumulated = 0
    }
  }
  @discardableResult func scroll(rows: Int) -> Bool {
    guard active, let view, !view.hasActiveSelection, rows != 0 else { return false }
    let terminal = view.getTerminal()
    if terminal.isCurrentBufferAlternate, isTmux() {
      let button = rows > 0 ? 64 : 65
      let col = max(1, terminal.cols / 2)
      let row = max(1, terminal.rows / 2)
      let input = String(repeating: "\u{1b}[<\(button);\(col);\(row)M", count: abs(rows))
      return sendScroll?(input, rows) ?? false
    }
    // Unlike pageUp/pageDown, scrollUp/Down never emit cursor keys in a PTY alternate screen.
    if rows > 0 { view.scrollUp(lines: rows) } else { view.scrollDown(lines: -rows) }
    return true
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
