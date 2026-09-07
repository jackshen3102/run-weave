import UIKit

@MainActor
public protocol TerminalSurface: AnyObject {
  var view: UIView { get }
  var rawInput: (([UInt8]) -> Void)? { get set }
  var viewportChanged: ((Int, Int) -> Void)? { get set }
  var bell: (() -> Void)? { get set }
  var scrollState: ((Double) -> Void)? { get set }
  func reset()
  func feed(_ bytes: [UInt8])
  func setActive(_ active: Bool)
  func dispose()
}
