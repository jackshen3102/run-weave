import SwiftUI
import UIKit

/// A separate presentation keeps keyboard/composer resizing out of the terminal's viewport.
struct TerminalComposerPresentation: UIViewControllerRepresentable {
  let session: AppSession
  let controller: SessionController
  let terminalID: String
  @Binding var isPresented: Bool
  @Binding var preventsDismissal: Bool
  @Binding var showingInstantReplies: Bool
  var onDismiss: () -> Void
  @EnvironmentObject private var quickReplies: LocalQuickReplyStore
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIViewController(context: Context) -> Anchor {
    let anchor = Anchor()
    anchor.view.backgroundColor = .clear
    anchor.view.isUserInteractionEnabled = false
    anchor.didAppear = { [weak coordinator = context.coordinator] in coordinator?.update() }
    context.coordinator.anchor = anchor
    return anchor
  }

  func updateUIViewController(_ anchor: Anchor, context: Context) {
    context.coordinator.parent = self
    // Read the binding during SwiftUI's update so presentation changes invalidate this bridge.
    context.coordinator.requested = isPresented
    // Presentation is a UIKit side effect, outside SwiftUI's update transaction.
    DispatchQueue.main.async { [weak coordinator = context.coordinator] in coordinator?.update() }
  }

  static func dismantleUIViewController(_ anchor: Anchor, coordinator: Coordinator) {
    anchor.didAppear = nil
    coordinator.anchor = nil
    coordinator.presented?.dismiss(animated: false)
    coordinator.presented = nil
  }

  private func content(onDismiss: @escaping () -> Void) -> AnyView {
    AnyView(
      TerminalComposerSheet(
        session: session, controller: controller, terminalID: terminalID,
        preventsDismissal: $preventsDismissal, showingInstantReplies: $showingInstantReplies,
        onDismiss: onDismiss
      )
      .environmentObject(quickReplies)
      .environment(\.scenePhase, scenePhase)
      .preferredColorScheme(colorScheme)
      .tint(TerminalAppearance.accent)
      // UIKit's keyboard guide is the sole owner of the available height.
      .ignoresSafeArea(.keyboard)
    )
  }

  final class Anchor: UIViewController {
    var didAppear: (() -> Void)?
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      didAppear?()
    }
  }

  final class Coordinator {
    var parent: TerminalComposerPresentation
    weak var anchor: Anchor?
    var presented: Container?
    var requested = false
    private var dismissing = false

    init(_ parent: TerminalComposerPresentation) { self.parent = parent }

    func update() {
      guard let anchor, anchor.view.window != nil, !dismissing else { return }
      if requested {
        if let presented {
          presented.host.rootView = content(id: presented.id)
          return
        }
        guard anchor.presentedViewController == nil else { return }
        let id = UUID()
        let next = Container(id: id, content: content(id: id))
        presented = next
        anchor.present(next, animated: true)
      } else if let presented {
        dismissing = true
        presented.view.endEditing(true)
        presented.dismiss(animated: true) { [weak self] in
          guard let self else { return }
          self.presented = nil
          self.dismissing = false
          self.parent.onDismiss()
          self.update()
        }
      }
    }

    private func content(id: UUID) -> AnyView {
      parent.content { [weak self] in
        // A late send confirmation from a closed editor must not dismiss a newly opened one.
        guard let self, self.presented?.id == id, !self.dismissing else { return }
        self.parent.isPresented = false
      }
    }
  }

  final class Container: UIViewController {
    let id: UUID
    let host: UIHostingController<AnyView>

    init(id: UUID, content: AnyView) {
      self.id = id
      host = UIHostingController(rootView: content)
      super.init(nibName: nil, bundle: nil)
      modalPresentationStyle = .overFullScreen
      modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
      super.viewDidLoad()
      view.backgroundColor = UIColor.black.withAlphaComponent(0.3)
      view.accessibilityViewIsModal = true
      addChild(host)
      host.view.backgroundColor = .clear
      host.view.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(host.view)
      NSLayoutConstraint.activate([
        host.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
        host.view.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
        host.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        host.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      ])
      host.didMove(toParent: self)
    }
  }
}
