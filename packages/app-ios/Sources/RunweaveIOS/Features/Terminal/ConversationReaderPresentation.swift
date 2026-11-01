import SwiftUI
import UIKit

/// Keep the terminal mounted at its original viewport while the reader slides over it.
struct ConversationReaderPresentation: UIViewControllerRepresentable {
  let session: AppSession
  let controller: SessionController
  let terminalID: String
  let title: String
  let expectedTarget: TerminalConversation.Target?
  @Binding var isPresented: Bool
  let onDismiss: () -> Void
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.mobileAnalyticsDepth) private var analyticsDepth

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIViewController(context: Context) -> Anchor {
    let anchor = Anchor()
    anchor.view.isUserInteractionEnabled = false
    anchor.view.backgroundColor = .clear
    anchor.didAppear = { [weak coordinator = context.coordinator] in coordinator?.update() }
    context.coordinator.anchor = anchor
    return anchor
  }

  func updateUIViewController(_ anchor: Anchor, context: Context) {
    context.coordinator.parent = self
    context.coordinator.requested = isPresented
    DispatchQueue.main.async { [weak coordinator = context.coordinator] in coordinator?.update() }
  }

  static func dismantleUIViewController(_ anchor: Anchor, coordinator: Coordinator) {
    anchor.didAppear = nil
    coordinator.anchor = nil
    coordinator.presented?.transitionEnded = nil
    coordinator.presented?.dismiss(animated: false)
    coordinator.presented = nil
  }

  final class Anchor: UIViewController {
    var didAppear: (() -> Void)?
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      didAppear?()
    }
  }

  final class Coordinator {
    var parent: ConversationReaderPresentation
    weak var anchor: Anchor?
    var presented: ReaderHost?
    var requested = false

    init(_ parent: ConversationReaderPresentation) { self.parent = parent }

    func update() {
      guard let anchor, anchor.view.window != nil else { return }
      if let presented {
        guard !presented.isBeingPresented, !presented.isBeingDismissed else { return }
        if requested {
          presented.host.rootView = content()
        } else {
          presented.dismiss(animated: true)
        }
      } else if requested, anchor.presentedViewController == nil {
        let host = ReaderHost(rootView: content())
        host.transitionEnded = { [weak self] completed in
          guard let self else { return }
          if completed {
            self.presented = nil
            self.requested = false
            self.parent.isPresented = false
            self.parent.onDismiss()
          }
          self.update()
        }
        presented = host
        anchor.present(host, animated: true) { [weak self] in self?.update() }
      }
    }

    private func content() -> AnyView {
      AnyView(
        ConversationReaderView(
          session: parent.session, controller: parent.controller, terminalID: parent.terminalID,
          title: parent.title, expectedTarget: parent.expectedTarget,
          close: { [weak self] in self?.parent.isPresented = false })
        .mobileAnalyticsScreen(.conversationReader)
        .environment(\.mobileAnalyticsDepth, parent.analyticsDepth)
        .environment(\.scenePhase, parent.scenePhase)
        .preferredColorScheme(parent.colorScheme)
        .background(TerminalAppearance.background.ignoresSafeArea())
        .ignoresSafeArea(.keyboard)
      )
    }
  }

  final class ReaderHost: UIViewController, UIViewControllerTransitioningDelegate, UIGestureRecognizerDelegate {
    let host: UIHostingController<AnyView>
    var transitionEnded: ((Bool) -> Void)?
    private var interaction: UIPercentDrivenInteractiveTransition?

    init(rootView: AnyView) {
      host = UIHostingController(rootView: rootView)
      super.init(nibName: nil, bundle: nil)
      // Unlike fullScreen, overFullScreen retains the presenting terminal's view hierarchy.
      modalPresentationStyle = .overFullScreen
      transitioningDelegate = self
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
      super.viewDidLoad()
      view.backgroundColor = UIColor(TerminalAppearance.background)
      view.accessibilityViewIsModal = true
      addChild(host)
      host.view.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(host.view)
      NSLayoutConstraint.activate([
        host.view.topAnchor.constraint(equalTo: view.topAnchor),
        host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      ])
      host.didMove(toParent: self)
      let edge = UIPanGestureRecognizer(target: self, action: #selector(swipeBack(_:)))
      edge.maximumNumberOfTouches = 1
      edge.delegate = self
      view.addGestureRecognizer(edge)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard let pan = gestureRecognizer as? UIPanGestureRecognizer,
        presentedViewController == nil, !isBeingPresented, !isBeingDismissed else { return false }
      let velocity = pan.velocity(in: view)
      return velocity.x > abs(velocity.y)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
      let location = touch.location(in: view)
      // Restrict the pan to the left edge; ordinary reading and code scrolling keep their gestures.
      return location.x <= 24
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
      // SwiftUI's reader scroll view must not prevent the ancestor's edge gesture.
      true
    }

    @objc private func swipeBack(_ gesture: UIPanGestureRecognizer) {
      let progress = min(1, max(0, gesture.translation(in: view).x / max(1, view.bounds.width)))
      switch gesture.state {
      case .began:
        let transition = UIPercentDrivenInteractiveTransition()
        transition.completionCurve = .easeOut
        interaction = transition
        dismiss(animated: true)
      case .changed:
        interaction?.update(progress)
      case .ended:
        let velocity = gesture.velocity(in: view).x
        if progress > 0.35 || (progress > 0.05 && velocity > 600) {
          interaction?.finish()
        } else {
          interaction?.cancel()
        }
        interaction = nil
      case .cancelled, .failed:
        interaction?.cancel()
        interaction = nil
      default: break
      }
    }

    func animationController(forPresented presented: UIViewController, presenting: UIViewController,
      source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
      Slide(presenting: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
      Slide(presenting: false) { [weak self] completed in
        DispatchQueue.main.async { self?.transitionEnded?(completed) }
      }
    }

    func interactionControllerForDismissal(using animator: UIViewControllerAnimatedTransitioning)
      -> UIViewControllerInteractiveTransitioning? { interaction }
  }

  private final class Slide: NSObject, UIViewControllerAnimatedTransitioning {
    let presenting: Bool
    let completion: ((Bool) -> Void)?

    init(presenting: Bool, completion: ((Bool) -> Void)? = nil) {
      self.presenting = presenting
      self.completion = completion
    }

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval {
      UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.28
    }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
      let key: UITransitionContextViewControllerKey = presenting ? .to : .from
      let viewKey: UITransitionContextViewKey = presenting ? .to : .from
      guard let controller = context.viewController(forKey: key), let view = context.view(forKey: viewKey) else {
        context.completeTransition(false)
        return
      }
      let frame = presenting ? context.finalFrame(for: controller) : context.initialFrame(for: controller)
      if presenting { context.containerView.addSubview(view) }
      view.frame = frame
      let shifted = frame.offsetBy(dx: context.containerView.bounds.width, dy: 0)
      if presenting { view.frame = shifted }
      UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: .curveEaseOut) {
        view.frame = self.presenting ? frame : shifted
      } completion: { _ in
        let completed = !context.transitionWasCancelled
        if !completed { view.frame = frame }
        context.completeTransition(completed)
        self.completion?(completed)
      }
    }
  }
}
