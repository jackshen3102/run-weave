import Clarity
import MarkdownUI
import SwiftUI

struct ConversationReaderView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let controller: SessionController
  let terminalID: String
  let title: String
  @StateObject private var model: ConversationReaderModel
  @StateObject private var anchor = ConversationScrollAnchor()

  init(session: AppSession, controller: SessionController, terminalID: String, title: String) {
    self.session = session; self.controller = controller; self.terminalID = terminalID; self.title = title
    _model = StateObject(wrappedValue: ConversationReaderModel(session: session, controller: controller, terminalID: terminalID))
  }
  var body: some View {
    NavigationView {
      VStack(spacing: 0) {
        if let failure = model.failure {
          Text(failure).font(.caption).foregroundColor(.orange).frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .accessibilityIdentifier("conversation-error")
        }
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
              Text(model.data?.target?.provider ?? "Agent").font(.caption).foregroundColor(TerminalAppearance.accent)
              Text(title).font(.title2.bold())
              Text("\(model.data?.turns.count ?? 0) 轮对话").font(.caption).foregroundColor(.secondary)
            }
            ForEach(Array((model.data?.turns ?? []).enumerated()), id: \.element.id) { index, turn in
              VStack(alignment: .leading, spacing: 24) {
                Divider()
                ForEach(turn.messages) { message in
                  VStack(alignment: .leading, spacing: 12) {
                    Text(message.role == "user" ? "你 · 第 \(index + 1) 轮" : model.data?.target?.provider ?? "Agent")
                      .font(.caption).foregroundColor(TerminalAppearance.accent)
                    Markdown(message.text).markdownTheme(.gitHub).textSelection(.enabled)
                      .markdownBlockStyle(\.table) { configuration in
                        ScrollView(.horizontal) { configuration.label }
                      }
                      .environment(\.openURL, OpenURLAction { url in
                        ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
                      })
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(message.role == "user" ? 16 : 0)
                  .background(message.role == "user" ? TerminalAppearance.panel : Color.clear)
                  .cornerRadius(12)
                  .background(GeometryReader { geometry in
                    Color.clear.preference(key: ConversationMessageFrames.self, value: [message.id: geometry.frame(in: .global)])
                  })
                }
              }
            }
            if model.data?.turns.isEmpty != false {
              Text(model.loading ? "正在读取会话…" : emptyText).foregroundColor(.secondary)
                .frame(maxWidth: .infinity).padding(.vertical, 48)
            }
          }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(ConversationScrollProbe(anchor: anchor).frame(width: 0, height: 0))
        }.accessibilityIdentifier("conversation-scroll")
          .onPreferenceChange(ConversationMessageFrames.self) { anchor.update($0) }
        HStack {
          Text(status).font(.caption2).foregroundColor(.secondary)
          Spacer()
          Button { anchor.latest() } label: { Label("回到最新", systemImage: "arrow.down") }.font(.caption)
        }.padding(16).background(TerminalAppearance.panel)
      }
      .background(TerminalAppearance.background)
      .navigationTitle("会话阅读").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("终端") { dismiss() } }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button { anchor.capture(); model.refresh() } label: {
            if model.loading { ProgressView() } else { Image(systemName: "arrow.clockwise") }
          }.disabled(model.loading).accessibilityLabel("刷新").accessibilityIdentifier("conversation-refresh")
        }
      }
    }.navigationViewStyle(.stack).tint(TerminalAppearance.accent).clarityMask()
      .onAppear { model.open() }.onDisappear { model.cancel() }
      .onChange(of: model.data?.readAt) { _ in anchor.commit() }
      .onChange(of: session.generation) { _ in model.cancel(); dismiss() }
      .onChange(of: session.terminal?.id) { id in if id != terminalID { model.cancel(); dismiss() } }
      .onChange(of: session.terminalController.map(ObjectIdentifier.init)) { identity in
        if identity != ObjectIdentifier(controller) { model.cancel(); dismiss() }
      }
  }
  private var emptyText: String {
    if model.failure != nil && model.data == nil { return "点击刷新重试" }
    switch model.data?.availability {
    case "no_thread": return "当前终端暂无关联会话"
    case "provider_unsupported": return "当前 Agent 暂不支持会话阅读"
    case "source_missing": return "会话记录已不可用"
    default: return "暂无可读取的对话"
    }
  }
  private var status: String {
    guard let data = model.data else { return "尚未读取" }
    let time = scheduledParseDate(data.readAt).map { $0.formatted(date: .omitted, time: .standard) } ?? data.readAt
    return "读取于 \(time)" + (data.partial ? " · 部分内容不可读" : model.unchanged ? " · 内容无变化" : "")
  }
}
