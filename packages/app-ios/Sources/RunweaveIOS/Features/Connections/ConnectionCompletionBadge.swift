import SwiftUI

struct ConnectionCompletionBadge: View {
  let count: Int

  var body: some View {
    if count > 0 {
      Text(String(count))
        .font(.system(size: 12, weight: .bold)).monospacedDigit()
        .foregroundColor(Color(red: 0.03, green: 0.08, blue: 0.04))
        .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20)
        .background(Color.green).clipShape(Capsule())
        .accessibilityLabel("\(count) 个未读完成终端")
    }
  }
}
