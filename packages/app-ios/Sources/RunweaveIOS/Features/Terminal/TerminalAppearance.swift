import SwiftUI
import UIKit

/// Colors shared by the native terminal surface and its surrounding controls.
enum TerminalAppearance {
  static func backgroundColor(dark: Bool) -> UIColor {
    dark ? UIColor(red: 16 / 255, green: 19 / 255, blue: 22 / 255, alpha: 1) : .systemBackground
  }

  static let background = Color(UIColor { backgroundColor(dark: $0.userInterfaceStyle == .dark) })
  static let panel = Color(
    UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 32 / 255, green: 39 / 255, blue: 43 / 255, alpha: 1)
        : .secondarySystemBackground
    })
  static let accent = Color(
    UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 165 / 255, green: 217 / 255, blue: 201 / 255, alpha: 1)
        : UIColor(red: 25 / 255, green: 104 / 255, blue: 83 / 255, alpha: 1)
    })
  static let border = Color.primary.opacity(0.15)
}

struct TerminalControlButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 18, weight: .medium))
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}

struct TerminalNavigationBackground: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 16.0, *) {
      content
        .toolbarBackground(TerminalAppearance.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    } else {
      content
    }
  }
}
