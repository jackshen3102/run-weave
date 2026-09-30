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
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.mobileAnalyticsDepth) private var analyticsDepth

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
    context.coordinator.inputs = Inputs(self)
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
      .mobileAnalyticsScreen(.composer)
      .environment(\.mobileAnalyticsDepth, analyticsDepth)
      .environmentObject(quickInputs)
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
    var inputs: Inputs?
    private var dismissing = false

    init(_ parent: TerminalComposerPresentation) { self.parent = parent }

    func update() {
      guard let anchor, anchor.view.window != nil, !dismissing, let inputs else { return }
      if requested {
        if let presented {
          // AppSession also publishes changes for other terminals. Updating the hosting root
          // invalidates an open UIKit menu even when none of its inputs changed.
          guard presented.inputs != inputs else { return }
          presented.inputs = inputs
          presented.host.rootView = content(id: presented.id)
          return
        }
        guard anchor.presentedViewController == nil else { return }
        let id = UUID()
        let next = Container(id: id, inputs: inputs, content: content(id: id))
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

  /// The presentation owns only identity, bindings and forwarded environment values.
  /// ComposerView observes its terminal's data through TerminalComposerState independently.
  struct Inputs: Equatable {
    let session: ObjectIdentifier
    let controller: ObjectIdentifier
    let terminalID: String
    let quickInputs: ObjectIdentifier
    let preventsDismissal: Bool
    let showingInstantReplies: Bool
    let scenePhase: ScenePhase
    let colorScheme: ColorScheme

    init(_ presentation: TerminalComposerPresentation) {
      session = ObjectIdentifier(presentation.session)
      controller = ObjectIdentifier(presentation.controller)
      terminalID = presentation.terminalID
      quickInputs = ObjectIdentifier(presentation.quickInputs)
      preventsDismissal = presentation.preventsDismissal
      showingInstantReplies = presentation.showingInstantReplies
      scenePhase = presentation.scenePhase
      colorScheme = presentation.colorScheme
    }
  }

  final class Container: UIViewController {
    let id: UUID
    var inputs: Inputs
    let host: UIHostingController<AnyView>

    init(id: UUID, inputs: Inputs, content: AnyView) {
      self.id = id
      self.inputs = inputs
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
