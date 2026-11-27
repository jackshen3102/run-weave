import SwiftUI

struct TerminalQuestionHandoffView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var questions: TerminalQuestionsModel
  let target: TerminalQuestionHandoff
  let close: () -> Void
  @State private var retry = 0
  @State private var checking = true

  private var activeComputer: Bool { session.connection?.scope == target.connectionScope }
  private var canRead: Bool { activeComputer && session.authenticated && session.health.status == .online }

  var body: some View {
    NavigationView {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let computer = session.connection, activeComputer {
            Label(computer.name, systemImage: "desktopcomputer").font(.subheadline).foregroundStyle(.secondary)
          }
          if checking {
            ProgressView("正在核对原问题…")
          } else {
            switch questions.notificationStatus {
            case .pending:
              if let request = questions.response?.requests.first, let terminalID = questions.notificationTerminalID {
                Text("原任务的问题").font(.headline)
                TerminalQuestionForm(questions: questions, request: request, canEdit: canRead, canWrite: canRead && session.canWrite) {
                  guard canRead, session.canWrite, let api = session.api else { return }
                  Task { await questions.submit(api: api, terminalID: terminalID, request: request) }
                }
              }
            case .closed:
              Text(questions.notificationResolved ? "问题已处理" : "问题已结束")
                .font(.title2.bold()).accessibilityIdentifier("codex-question-handoff-state")
            case .unavailable, nil:
              if questions.notificationTerminalOnly {
                Text("等待你在原终端确认")
                  .font(.title2.bold()).accessibilityIdentifier("codex-question-handoff-state")
                Text("请打开原终端查看选项或完成确认。")
                  .foregroundStyle(.secondary)
              } else {
                Text("暂时无法核对").font(.title2.bold()).accessibilityIdentifier("codex-question-handoff-state")
                Button("重新检查") { retry += 1 }
                  .buttonStyle(.borderedProminent).accessibilityIdentifier("codex-question-handoff-retry")
              }
            }
            if questions.notificationSubmissionNeedsCheck {
              Text("提交状态待核对，答案草稿已保留。").foregroundStyle(.secondary)
                .accessibilityIdentifier("codex-question-handoff-submit-unconfirmed")
            }
            if let terminalID = questions.notificationTerminalID {
              Button("回原终端查看") {
                guard canRead else { return }
                Task {
                  await openTerminal(terminalID, panelID: questions.notificationPanelID, focusPanel: true)
                  if activeComputer, session.terminal?.id == terminalID { close() }
                }
              }.disabled(!canRead).accessibilityIdentifier("codex-question-handoff-terminal")
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding()
      }
      .navigationTitle(questions.notificationTitle ?? (questions.notificationTerminalOnly ? "终端待确认" : "Codex 回复辅助"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("关闭", action: close) }
      }
    }
    .navigationViewStyle(.stack)
    .task(id: retry) { await check() }
    .onChange(of: session.generation) { _ in questions.invalidateNotificationTransport(target) }
    .onDisappear { questions.closeNotification(target) }
  }

  private func check() async {
    checking = true
    if retry == 0 {
      questions.openNotification(target)
      // The notification may have selected a different saved computer.
      let deadline = Date().addingTimeInterval(8)
      while (!activeComputer || !session.foreground || session.checking || session.health.status == .checking) && Date() < deadline {
        do { try await Task.sleep(nanoseconds: 150_000_000) } catch { return }
      }
    } else if activeComputer && !canRead {
      await session.reconnectRoutes()
    }
    guard !Task.isCancelled else { return }
    guard canRead, let api = session.api else {
      questions.notificationUnavailable(target)
      checking = false
      return
    }
    await questions.refreshNotification(api: api, target: target)
    guard !Task.isCancelled else { return }
    if questions.notificationStatus == .unavailable, questions.notificationTerminalOnly,
      let terminalID = questions.notificationTerminalID {
      await openTerminal(terminalID, panelID: questions.notificationPanelID, focusPanel: true)
      guard !Task.isCancelled else { return }
      if activeComputer, session.terminal?.id == terminalID {
        close()
        return
      }
    }
    checking = false
    if questions.notificationStatus == .pending, let terminalID = questions.notificationTerminalID {
      await openTerminal(terminalID, panelID: questions.notificationPanelID, focusPanel: false)
    }
    while !Task.isCancelled && questions.notificationStatus == .pending {
      do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
      guard canRead, session.api === api else {
        questions.notificationUnavailable(target)
        return
      }
      if session.foreground { await questions.refreshNotification(api: api, target: target) }
    }
  }

  private func openTerminal(_ id: String, panelID: String?, focusPanel: Bool) async {
    guard canRead else { return }
    var focused = false
    if focusPanel, session.canWrite, let api = session.api, let panelID, !panelID.isEmpty {
      do {
        try await api.focusTerminalPanel(terminalID: id, panelID: panelID)
        _ = await session.reload()
        focused = true
      } catch APIError.http(404), APIError.http(409) {
        _ = await session.reload()
      } catch {}
    }
    guard canRead else { return }
    session.showingScheduledTasks = false
    session.showingEnergyMonitor = false
    session.showingDevelopmentResources = false
    if session.terminal?.id != id || focused {
      await session.openTerminal(id)
    }
  }
}
