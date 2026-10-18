import SwiftUI

struct SideChatContextView: View {
  let source: SideChatSourceSnapshot
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationView {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text("创建时固定的来源轮次文字预览。主任务之后的内容不会自动加入。")
            .font(.caption).foregroundColor(.secondary)
          Text("轮次 \(source.lastCompletedTurnId)\n\(source.model)\n\(source.cwd)")
            .font(.caption).foregroundColor(.secondary).textSelection(.enabled)
          ForEach(Array(source.preview.enumerated()), id: \.offset) { _, message in
            VStack(alignment: .leading, spacing: 8) {
              Text(message.role == "user" ? "用户" : "助手").font(.headline)
              Text(message.text).textSelection(.enabled)
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding()
      }
      .navigationTitle("来源上下文").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }.navigationViewStyle(.stack).clarityMask()
  }
}
