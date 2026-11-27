import Clarity
import SwiftUI
import UIKit

public struct TerminalHostView: UIViewRepresentable {
  public let surface: SwiftTermSurface
  public var localHistory: LocalHistoryScrollController?
  public var covered: Bool
  public init(
    surface: SwiftTermSurface,
    localHistory: LocalHistoryScrollController? = nil,
    covered: Bool = false
  ) {
    self.surface = surface
    self.localHistory = localHistory
    self.covered = covered
  }
  public func makeUIView(context: Context) -> UIView {
    ClaritySDK.maskView(surface.view)
    let host = ViewportHost(terminal: surface.view, covered: covered)
    host.bind(localHistory: localHistory)
    return host
  }
  public func updateUIView(_ view: UIView, context: Context) {
    guard let host = view as? ViewportHost else { return }
    host.covered = covered
    host.bind(localHistory: localHistory)
    host.setNeedsLayout()
  }
}

/// A modal owns its keyboard layout, while the live terminal retains its viewport.
/// Window size changes still resize the terminal when the device rotates under a modal.
private final class ViewportHost: UIView {
  let terminal: UIView
  private weak var boundLocalHistory: LocalHistoryScrollController?
  private var historyTerminal: UIView?
  private var showingHistory = false
  var covered: Bool
  private var viewport: CGSize = .zero
  private var windowSize: CGSize = .zero

  init(terminal: UIView, covered: Bool) {
    self.terminal = terminal
    self.covered = covered
    super.init(frame: .zero)
    addSubview(terminal)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func bind(localHistory: LocalHistoryScrollController?) {
    if boundLocalHistory !== localHistory {
      boundLocalHistory?.onVisibilityChanged = nil
      boundLocalHistory = localHistory
      localHistory?.onVisibilityChanged = { [weak self] historySurface, showing in
        self?.syncHistoryLayer(historySurface: historySurface, showing: showing)
      }
    }
    syncHistoryLayer(
      historySurface: localHistory?.surface,
      showing: localHistory?.isShowingLocalHistory ?? false
    )
  }

  func syncHistoryLayer(historySurface: SwiftTermSurface?, showing: Bool) {
    let nextView = historySurface?.view
    if historyTerminal !== nextView {
      historyTerminal?.removeFromSuperview()
      historyTerminal = nextView
      if let nextView {
        ClaritySDK.maskView(nextView)
        addSubview(nextView)
        if viewport.width > 0, viewport.height > 0 {
          nextView.frame = CGRect(origin: .zero, size: viewport)
        }
      }
    }
    showingHistory = showing && historyTerminal != nil
    historyTerminal?.isHidden = !showingHistory
    historyTerminal?.isUserInteractionEnabled = showingHistory
    historyTerminal?.accessibilityElementsHidden = !showingHistory
    terminal.alpha = showingHistory ? 0 : 1
    terminal.isUserInteractionEnabled = !showingHistory
    terminal.accessibilityElementsHidden = showingHistory
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    let currentWindow = window?.bounds.size ?? windowSize
    if !covered || viewport == .zero || currentWindow != windowSize {
      viewport = bounds.size
      windowSize = currentWindow
    }
    let frame = CGRect(origin: .zero, size: viewport)
    terminal.frame = frame
    historyTerminal?.frame = frame
  }
}
