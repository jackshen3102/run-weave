import SwiftUI

struct TerminalTitleView: View {
  let title: String
  let projectName: String
  let connectionName: String
  let status: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      (Text(title).fontWeight(.semibold) + Text(" / \(projectName)").foregroundColor(.secondary))
        .font(.subheadline).lineLimit(1)
      HStack(spacing: 4) {
        Circle().fill(status == "已连接" ? TerminalAppearance.accent : .orange)
          .frame(width: 5, height: 5)
        Text("\(connectionName) · \(status)")
          .font(.caption2).foregroundColor(.secondary).lineLimit(1)
      }
    }
    .accessibilityElement(children: .combine)
  }
}
