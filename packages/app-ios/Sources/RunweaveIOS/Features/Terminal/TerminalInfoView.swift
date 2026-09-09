import SwiftUI
import UIKit

struct TerminalInfoView: View {
  @Environment(\.dismiss) private var dismiss
  let terminalID: String
  @State private var copied = false

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("终端 ID")) {
          Text(terminalID)
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("terminal-info-id")
          Button {
            UIPasteboard.general.string = terminalID
            copied = true
          } label: {
            Label(copied ? "已复制" : "复制终端 ID", systemImage: copied ? "checkmark" : "doc.on.doc")
          }
          .accessibilityIdentifier("terminal-info-copy-id")
        }
      }
      .navigationTitle("终端信息")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("关闭") { dismiss() }
        }
      }
    }.navigationViewStyle(.stack)
  }
}
