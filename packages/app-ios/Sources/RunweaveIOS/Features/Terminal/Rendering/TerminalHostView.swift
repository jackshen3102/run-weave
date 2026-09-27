import Clarity
import SwiftUI
import UIKit

public struct TerminalHostView: UIViewRepresentable {
  public let surface: SwiftTermSurface
  public init(surface: SwiftTermSurface) { self.surface = surface }
  public func makeUIView(context: Context) -> UIView {
    ClaritySDK.maskView(surface.view)
    return surface.view
  }
  public func updateUIView(_ view: UIView, context: Context) {}
}
