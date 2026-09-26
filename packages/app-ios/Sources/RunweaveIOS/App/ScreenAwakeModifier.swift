import SwiftUI
import UIKit

/// Applies the same screen policy to every app page, including diagnostic entry points.
public struct ScreenAwakeModifier: ViewModifier {
  static let preferenceKey = DevicePreferences.screenAwakeKey

  @Environment(\.scenePhase) private var scenePhase
  @AppStorage(DevicePreferences.screenAwakeKey, store: DevicePreferences.store) private var keepScreenAwake = true

  public init() {}

  public func body(content: Content) -> some View {
    content
      .onAppear { updateIdleTimer(phase: scenePhase, enabled: keepScreenAwake) }
      .onChange(of: scenePhase) { phase in
        updateIdleTimer(phase: phase, enabled: keepScreenAwake)
      }
      .onChange(of: keepScreenAwake) { enabled in
        updateIdleTimer(phase: scenePhase, enabled: enabled)
      }
  }

  private func updateIdleTimer(phase: ScenePhase, enabled: Bool) {
    // onChange's captured environment can still contain the previous value.
    UIApplication.shared.isIdleTimerDisabled = enabled && phase == .active
  }
}
