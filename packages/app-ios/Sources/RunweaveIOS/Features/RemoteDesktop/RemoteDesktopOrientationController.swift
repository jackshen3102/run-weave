import SwiftUI
import UIKit

/// A child of the existing full-screen cover. The app delegate reads its mask
/// from the visible controller tree, so no direction policy outlives this cover.
@MainActor
final class RemoteDesktopOrientationController: UIViewController, ObservableObject {
  @Published private(set) var isLandscape = false
  @Published private(set) var isChanging = false
  @Published var errorMessage: String?
  private var selectedOrientation: UIInterfaceOrientation?
  private var entryOrientation: UIInterfaceOrientation?
  private var active = false
  private var transitioning = false
  private var rotationTask: Task<Void, Never>?
  private var requestID = UUID()

  var actionTitle: String { isLandscape ? "切换竖屏" : "切换横屏" }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    selectedOrientation.map(Self.mask) ?? .allButUpsideDown
  }

  override func loadView() {
    view = UIView()
    view.isUserInteractionEnabled = false
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    active = true
    if rotationTask == nil { isChanging = false }
    if entryOrientation == nil { entryOrientation = view.window?.windowScene?.interfaceOrientation }
    refreshDirection()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    // Layout callbacks may run during a SwiftUI update.
    DispatchQueue.main.async { [weak self] in self?.refreshDirection() }
  }

  override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    transitioning = true
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in
      self?.transitioning = false
      self?.refreshDirection()
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    restore()
    super.viewWillDisappear(animated)
  }

  func toggle() {
    guard active, !isChanging, let scene = view.window?.windowScene else { return }
    guard #available(iOS 16.0, *) else {
      errorMessage = "手动切换屏幕方向需要 iOS 16 或更新版本。"
      return
    }
    let target: UIInterfaceOrientation = scene.interfaceOrientation.isLandscape ? .portrait : .landscapeRight
    let previous = selectedOrientation
    let id = UUID()
    requestID = id
    selectedOrientation = target
    isChanging = true
    errorMessage = nil
    rotationTask = Task { [weak self, weak scene] in
      // Let SwiftUI suspend remote gestures and dismiss text entry first.
      await Task.yield()
      guard let self, let scene, self.active, self.requestID == id, !Task.isCancelled else { return }
      self.invalidateSupportedOrientations()
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: Self.mask(target))) { [weak self] _ in
        guard let self, self.active, self.requestID == id, self.isChanging else { return }
        self.finish(previous: previous, failed: true)
      }
      // A successful request is not proof that UIKit actually rotated the scene.
      for _ in 0..<30 {
        do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
        guard self.active, self.requestID == id else { return }
        guard self.view.window?.windowScene === scene else {
          self.finish(previous: previous, failed: true)
          return
        }
        if scene.interfaceOrientation == target && !self.transitioning {
          self.finish(previous: previous, failed: false)
          return
        }
      }
      self.finish(previous: previous, failed: true)
    }
  }

  func becameActive() {
    guard active, let target = selectedOrientation, !isChanging,
      let scene = view.window?.windowScene, #available(iOS 16.0, *) else { return }
    invalidateSupportedOrientations()
    let id = UUID()
    requestID = id
    scene.requestGeometryUpdate(.iOS(interfaceOrientations: Self.mask(target))) { [weak self] _ in
      guard let self, self.active, self.requestID == id else { return }
      self.errorMessage = "未能切换屏幕方向，请重试。"
    }
  }

  func restore() {
    guard active else { return }
    active = false
    requestID = UUID()
    rotationTask?.cancel()
    rotationTask = nil
    let shouldRestore = selectedOrientation != nil
    selectedOrientation = nil
    guard shouldRestore, let entry = entryOrientation, entry != .unknown,
      let window = view.window, let scene = window.windowScene,
      #available(iOS 16.0, *) else { return }
    invalidateSupportedOrientations()
    let restoreDirection = { [weak window, weak scene] in
      guard let window, let scene,
        Self.visibleController(in: window.rootViewController) == nil else { return }
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: Self.mask(entry))) { _ in }
    }
    if let coordinator = transitionCoordinator {
      coordinator.animate(alongsideTransition: nil) { _ in restoreDirection() }
    } else {
      DispatchQueue.main.async(execute: restoreDirection)
    }
  }

  static func visibleController(in root: UIViewController?) -> RemoteDesktopOrientationController? {
    guard let root else { return nil }
    if let presented = root.presentedViewController,
      let controller = visibleController(in: presented) {
      return controller
    }
    if let controller = root as? RemoteDesktopOrientationController,
      controller.active, controller.viewIfLoaded?.window != nil { return controller }
    for child in root.children {
      if let controller = visibleController(in: child) { return controller }
    }
    return nil
  }

  private func finish(previous: UIInterfaceOrientation?, failed: Bool) {
    guard active, isChanging else { return }
    rotationTask?.cancel()
    rotationTask = nil
    if failed {
      selectedOrientation = previous
      invalidateSupportedOrientations()
      errorMessage = "未能切换屏幕方向，请重试。"
    }
    refreshDirection()
    isChanging = false
  }

  private func refreshDirection() {
    guard active, let direction = view.window?.windowScene?.interfaceOrientation,
      direction != .unknown, isLandscape != direction.isLandscape else { return }
    isLandscape = direction.isLandscape
  }

  private func invalidateSupportedOrientations() {
    guard #available(iOS 16.0, *) else { return }
    var controller: UIViewController? = self
    while let current = controller {
      current.setNeedsUpdateOfSupportedInterfaceOrientations()
      controller = current.parent
    }
  }

  private static func mask(_ orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask {
    switch orientation {
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .portraitUpsideDown: return .portraitUpsideDown
    default: return .portrait
    }
  }
}

struct RemoteDesktopOrientationBridge: UIViewControllerRepresentable {
  let controller: RemoteDesktopOrientationController
  func makeUIViewController(context: Context) -> RemoteDesktopOrientationController { controller }
  func updateUIViewController(_ controller: RemoteDesktopOrientationController, context: Context) {}
  static func dismantleUIViewController(_ controller: RemoteDesktopOrientationController, coordinator: ()) {
    controller.restore()
  }
}
