import Clarity
import SwiftUI
import UIKit

public struct TerminalHostView: UIViewRepresentable {
  public let surface: SwiftTermSurface
  public var covered: Bool
  public init(surface: SwiftTermSurface, covered: Bool = false) {
    self.surface = surface
    self.covered = covered
  }
  public func makeUIView(context: Context) -> UIView {
    ClaritySDK.maskView(surface.view)
    return ViewportHost(terminal: surface.view, covered: covered)
  }
  public func updateUIView(_ view: UIView, context: Context) {
    guard let host = view as? ViewportHost else { return }
    host.covered = covered
    host.setNeedsLayout()
  }
}

/// A modal owns its keyboard layout, while the live terminal retains its viewport.
/// Window size changes still resize the terminal when the device rotates under a modal.
private final class ViewportHost: UIView {
  let terminal: UIView
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

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    let currentWindow = window?.bounds.size ?? windowSize
    if !covered || viewport == .zero || currentWindow != windowSize {
      viewport = bounds.size
      windowSize = currentWindow
    }
    terminal.frame = CGRect(origin: .zero, size: viewport)
  }
}
