import SwiftUI
import UIKit

/// Applies the same screen policy to every app page, including diagnostic entry points.
public struct ScreenAwakeModifier: ViewModifier {
  static let preferenceKey = "native.keepScreenAwake"

  @Environment(\.scenePhase) private var scenePhase
  @AppStorage(ScreenAwakeModifier.preferenceKey) private var keepScreenAwake = true

  public init() {}

  public func body(content: Content) -> some View {
    content
      .onAppear { updateIdleTimer() }
      .onChange(of: scenePhase) { _ in updateIdleTimer() }
      .onChange(of: keepScreenAwake) { _ in updateIdleTimer() }
  }

  private func updateIdleTimer() {
    UIApplication.shared.isIdleTimerDisabled = keepScreenAwake && scenePhase == .active
  }
}
