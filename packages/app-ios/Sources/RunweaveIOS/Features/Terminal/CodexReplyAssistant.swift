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
  @ObservedObject var questions: TerminalQuestionsModel
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
      && (questions.response?.capability == "available" || terminal?.conversationPreview?.turnId == context.turnID)
      && terminal?.terminalState.agent == "codex"
  }

  var body: some View {
    NavigationView {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if contextMatches {
            liveQuestions
          }
          if questions.response?.capability != "available" || !contextMatches {
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
          }
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
      .task {
        questions.open(terminalID: terminalID, conversationKey: context.conversationKey)
        while !Task.isCancelled && session.generation == context.generation {
          if contextMatches, session.foreground, let api = session.api {
            await questions.refresh(api: api, terminalID: terminalID)
          }
          do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { break }
        }
      }
      .onDisappear { questions.close() }
  }

  @ViewBuilder private var liveQuestions: some View {
    if let error = questions.error {
      Text(error).foregroundColor(.orange).accessibilityIdentifier("codex-question-error")
    }
    if let response = questions.response {
      if response.capability == "available" {
        Text("原任务的问题").font(.headline)
        if response.requests.isEmpty {
          Text("当前没有收到结构化问题。普通文字问题请回终端回复。")
            .foregroundColor(.secondary)
        }
        ForEach(response.requests) { request in
          VStack(alignment: .leading, spacing: 12) {
            ForEach(request.questions) { question in
              Text(question.header).font(.subheadline.bold())
              Text(question.question).textSelection(.enabled)
              ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { _, option in
                Button {
                  questions.setAnswer(option.label, request: request, questionID: question.id)
                } label: {
                  VStack(alignment: .leading, spacing: 4) {
                    Label(option.label, systemImage: questions.answer(request, questionID: question.id) == option.label ? "checkmark.circle.fill" : "circle")
                    Text(option.description).font(.caption).foregroundColor(.secondary)
                  }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.bordered)
                  .disabled(!canEdit(request))
              }
              if question.options == nil || question.isOther {
                if question.isSecret {
                  SecureField("填写回答", text: answerBinding(request, question))
                    .textFieldStyle(.roundedBorder).disabled(!canEdit(request))
                } else {
                  TextField("填写回答", text: answerBinding(request, question))
                    .textFieldStyle(.roundedBorder).disabled(!canEdit(request))
                    .accessibilityIdentifier("codex-question-answer-\(question.id)")
                }
              }
            }
            if request.state == "pending" && !questions.hasSubmitted(request) {
              Button("提交给原任务") {
                guard contextMatches, session.canWrite, let api = session.api else { return }
                Task { await questions.submit(api: api, terminalID: terminalID, request: request) }
              }.buttonStyle(.borderedProminent)
                .disabled(!contextMatches || !session.canWrite || !questions.canSubmit(request))
                .accessibilityIdentifier("codex-question-submit")
            } else {
              Text(request.state == "submitting" || request.state == "pending" ? "已提交，等待原任务处理；请勿重复发送。"
                : request.state == "resolved" ? "问题已处理，请回原终端查看结果。"
                : "问题已结束，原答案草稿已保留，请回终端核对。")
                .foregroundColor(.secondary).accessibilityIdentifier("codex-question-state")
            }
          }.padding().background(Color.secondary.opacity(0.08)).cornerRadius(12)
        }
        Text("选择选项只修改答案草稿。提交不消耗终端输入草稿、附件或排队消息。")
          .font(.caption).foregroundColor(.secondary)
      } else {
        Text(response.reason ?? "当前运行方式不支持结构化回答，请回原终端操作。")
          .foregroundColor(.secondary).accessibilityIdentifier("codex-question-unavailable")
      }
    } else if questions.error == nil {
      ProgressView("正在核对原任务的问题…")
    }
  }

  private func canEdit(_ request: TerminalQuestionRequest) -> Bool {
    contextMatches && questions.error == nil && request.state == "pending" && !questions.submitting && !questions.hasSubmitted(request)
  }
  private func answerBinding(_ request: TerminalQuestionRequest, _ question: TerminalQuestion) -> Binding<String> {
    Binding(get: { questions.answer(request, questionID: question.id) },
      set: { questions.setAnswer($0, request: request, questionID: question.id) })
  }
}
