import SwiftUI

/// A frozen historical preview, never a pending-question or answered-state projection.
struct CodexReplyContext: Identifiable {
  let id = UUID()
  let generation: Int
  let conversationKey: String?
  let agentText: String?
  let turnID: String?
}

struct CodexReplyAssistant: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let terminalID: String
  let context: CodexReplyContext
  let returnToTerminal: () -> Void

  private var terminal: HomeTerminal? {
    session.overview?.sessions.first { $0.id == terminalID }
  }
  private var contextMatches: Bool {
    session.generation == context.generation && session.terminal?.id == terminalID
      && session.terminalController === controller && terminal?.status != "exited"
      && context.conversationKey != nil && terminal?.conversationKey == context.conversationKey
      && terminal?.conversationPreview?.turnId == context.turnID
      && terminal?.terminalState.agent == "codex"
  }

  var body: some View {
    NavigationView {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text("先在终端确认问题，再手动回复")
            .font(.headline)
          Text("这里展示历史 Agent 摘要，可能不完整或已过时，不代表当前仍有待回答的问题。以终端当前画面为准。")
            .font(.subheadline).foregroundColor(.secondary)
          if !contextMatches {
            Text("会话、面板或对话已变化。请关闭此页，在当前终端重新核对。")
              .foregroundColor(.orange).accessibilityIdentifier("codex-reply-context-expired")
          } else {
            VStack(alignment: .leading, spacing: 8) {
              Text("历史 Agent 摘要").font(.caption).foregroundColor(.secondary)
              Text(context.agentText ?? "暂无可用摘要，请直接查看终端。")
                .textSelection(.enabled)
            }.accessibilityIdentifier("codex-reply-history")
          }
          Text("返回后先检查当前问题是否仍有效；需要回复时，点右下角输入按钮手动输入。已有草稿会保留。")
          Text("排队消息是另一个输入流程，不是问题答案；若终端同时显示问题和队列，请先核对当前焦点。发送结果不明确时，先查看终端，不要重复发送。")
            .font(.subheadline).foregroundColor(.secondary)
          Button("回原终端核对", action: returnToTerminal)
            .buttonStyle(.borderedProminent)
            .disabled(!contextMatches || !session.canWrite || !controller.canSend)
            .accessibilityIdentifier("codex-reply-return")
        }.padding()
      }
      .navigationTitle("Codex 回复辅助")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("关闭") { dismiss() } }
      }
    }.navigationViewStyle(.stack)
  }
}
