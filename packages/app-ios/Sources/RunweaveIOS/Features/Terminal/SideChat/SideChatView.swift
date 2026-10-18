import SwiftUI
import Combine

struct SideChatView: View {
  @ObservedObject var model: SideChatModel
  @ObservedObject var session: AppSession
  let title: String
  let terminalID: String
  @State private var context = false
  @State private var ending = false
  @State private var messageViewport: CGFloat = 0
  @State private var messageFrames: [Int: CGRect] = [:]
  @State private var pinnedToBottom = true
  @State private var initialScrollDone = false
  private var mainStatus: String {
    switch model.snapshot?.sourceStatus {
    case "running": return "执行中"
    case "idle": return "等待输入"
    case "unavailable": return "原主会话不可用"
    default: return "状态待确认"
    }
  }
  var body: some View {
    NavigationView {
      VStack(spacing: 0) {
        if let source = model.snapshot?.sideChat.source {
          HStack {
            Button(source.turnNumber.map { "主对话 · 第 \($0) 轮" } ?? "主对话 · 固定来源轮次") { context = true }
              .accessibilityIdentifier("side-chat-context")
            Spacer()
            Text("主任务：\(mainStatus)").foregroundColor(.secondary)
          }.font(.caption).padding(.horizontal).padding(.vertical, 10)
          Divider()
        }
        if model.stale {
          HStack {
            Text("连接中断或数据已过期").foregroundColor(.orange)
            Spacer()
            Button("刷新") { Task { await model.refresh() } }
          }.font(.caption).padding(.horizontal)
        }
        if let failure = model.failure { Text(failure).font(.caption).foregroundColor(.red).padding(.horizontal) }
        if model.pending != nil {
          HStack {
            Text("正在核对操作结果…")
            Button("查询操作") { Task { await model.queryOperation(); await model.refresh() } }
              .accessibilityIdentifier("side-chat-query-operation")
          }.font(.caption).padding(.vertical, 6)
        }
        messageList
        if let turn = model.snapshot?.currentTurn, let label = turnLabel(turn.state) {
          HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            if ["accepted", "running"].contains(turn.state) {
              Button("停止") { Task { await model.stop() } }
                .disabled(model.stale || model.pending != nil).accessibilityIdentifier("side-chat-stop")
            }
          }.font(.caption).padding(.horizontal).padding(.vertical, 4)
        }
        if let status = model.snapshot?.sideChat.status, ["ended", "unavailable", "ending"].contains(status) {
          Text(status == "ended" ? "旁聊已结束。记录和本机未发送文字仍可查看、复制。" : status == "ending" ? "正在结束旁聊…" : "旁聊分支不可用。已收消息和草稿已保留。")
            .font(.caption).foregroundColor(.secondary).padding(.horizontal).padding(.vertical, 4)
        }
        Divider()
        SideChatComposer(model: model)
      }
      .background(Color(.systemBackground))
      .navigationTitle("旁聊 · \(title)").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) {
          Button("返回主对话") { model.returnToMain() }.accessibilityIdentifier("side-chat-return")
        }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("结束旁聊") { ending = true }
            .disabled(!model.canEnd)
            .accessibilityIdentifier("side-chat-end")
        }
      }
      .confirmationDialog("结束这段旁聊？", isPresented: $ending, titleVisibility: .visible) {
        Button("结束旁聊", role: .destructive) { Task { await model.end() } }
        Button("取消", role: .cancel) {}
      } message: { Text("当前回答会停止。结束后保留记录，下次进入会建立新的旁聊。") }
      .sheet(isPresented: $context) { if let source = model.snapshot?.sideChat.source { SideChatContextView(source: source) } }
    }
    .navigationViewStyle(.stack)
    .interactiveDismissDisabled()
    .onAppear { model.startPolling() }
    .clarityMask()
  }
  private var messageList: some View {
    GeometryReader { viewport in
      ScrollViewReader { scroll in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 20) {
            if model.snapshot?.beforeSequence != nil { Button("加载更早消息") { Task { await model.older() } } }
            if model.snapshot?.messages.isEmpty != false {
              Text("在这里就当前任务独立提问。\n返回后仍可继续。")
                .font(.subheadline).foregroundColor(.secondary).frame(maxWidth: .infinity).padding(.vertical, 40)
            }
            ForEach(model.snapshot?.messages ?? []) { message in
              HStack(alignment: .top, spacing: 0) {
                if message.role == "user" { Spacer(minLength: 0) }
                VStack(alignment: .leading, spacing: 6) {
                  Text(message.text).textSelection(.enabled)
                    .frame(maxWidth: message.role == "user" ? nil : .infinity, alignment: .leading)
                    .padding(message.role == "user" ? 12 : 0)
                    .background(message.role == "user" ? Color.accentColor.opacity(0.18) : Color.clear)
                    .cornerRadius(14)
                  if message.role == "user", message.turnId != model.snapshot?.currentTurn?.id,
                     let state = message.turnState, ["stopped", "failed", "unknown"].contains(state),
                     let label = turnLabel(state) {
                    Text(label).font(.caption).foregroundColor(.secondary)
                  }
                }
                .frame(maxWidth: message.role == "user" ? max(0, (viewport.size.width - 32) * 0.8) : .infinity, alignment: .trailing)
              }.id(message.id)
                .background(GeometryReader { geometry in
                  Color.clear.preference(key: SideChatMessageFrames.self,
                    value: [message.sequence: geometry.frame(in: .named("side-chat-message-viewport"))])
                })
            }
          }.padding()
        }
        .coordinateSpace(name: "side-chat-message-viewport")
        .background(GeometryReader { geometry in
          Color.clear.onAppear {
            messageViewport = geometry.size.height
            presentVisibleAnswers(frames: messageFrames, height: geometry.size.height)
          }
            .onChange(of: geometry.size.height) {
              messageViewport = $0
              presentVisibleAnswers(frames: messageFrames, height: $0)
            }
        })
        .onPreferenceChange(SideChatMessageFrames.self) { frames in
          messageFrames = frames
          presentVisibleAnswers(frames: frames, height: messageViewport)
          if let last = model.snapshot?.messages.last?.sequence, let frame = frames[last] {
            pinnedToBottom = frame.maxY <= messageViewport + 80
          }
        }
        .onAppear {
          if let last = model.snapshot?.messages.last { DispatchQueue.main.async { scroll.scrollTo(last.id, anchor: .bottom) } }
        }
        // Capture whether the old list was at the bottom before the new rows change its geometry.
        .onReceive(model.$snapshot.map { $0?.messages.last?.id }.removeDuplicates()) { id in
          guard let id, !initialScrollDone || pinnedToBottom else { return }
          initialScrollDone = true
          DispatchQueue.main.async { scroll.scrollTo(id, anchor: .bottom) }
        }
      }
    }
  }
  private func presentVisibleAnswers(frames: [Int: CGRect], height: CGFloat) {
    guard height > 0 else { return }
    let answers = Set((model.snapshot?.messages ?? []).filter { $0.role == "assistant" }.map(\.sequence))
    for (sequence, frame) in frames where answers.contains(sequence) && frame.maxY > 0 && frame.minY < height {
      model.presented(sequence: sequence)
    }
  }
  private func turnLabel(_ state: String) -> String? {
    switch state {
    case "accepted", "running": return "正在回答…"
    case "stopping": return "正在停止…"
    case "stopped": return "已停止回答"
    case "failed": return "回答失败，请重新提问"
    case "unknown": return "执行结果不明，请查询状态或结束旁聊"
    default: return nil
    }
  }
}

private struct SideChatMessageFrames: PreferenceKey {
  static var defaultValue: [Int: CGRect] = [:]
  static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
    value.merge(nextValue(), uniquingKeysWith: { _, new in new })
  }
}
