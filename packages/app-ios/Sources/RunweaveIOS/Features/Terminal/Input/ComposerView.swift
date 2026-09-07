import SwiftUI

struct ComposerView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let terminalID: String
  var active = true
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var failure: String?
  @State private var stopping = false
  private var hasText: Bool {
    !(session.terminalDrafts[terminalID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      .isEmpty
  }
  private var showStop: Bool { session.isCommandActive(terminalID) && !hasText }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--native-auth-validation"),
          verticalSizeClass != .compact,
          session.api?.baseURL.host == "127.0.0.1" || session.api?.baseURL.host == "localhost"
        {
          Button("调试：撤销远端登录") {
            Task {
              do {
                try await session.withConnection { try await $0.revokeRemoteLoginForValidation() }
                failure = "远端登录已撤销；发送草稿可验证认证失败处理"
              } catch { failure = displayError(error) }
            }
          }.font(.caption).disabled(!session.canWrite)
        }
      #endif
      HStack {
        if verticalSizeClass == .compact {
          ShortcutBar(controller: controller, enabled: session.canWrite)
        }
        MediaControls(session: session, terminalID: terminalID, visible: active)
          .frame(maxWidth: verticalSizeClass == .compact ? 180 : .infinity)
      }
      if let failure { Text(failure).font(.caption).foregroundColor(.red) }
      HStack(alignment: .bottom) {
        CommandTextView(
          text: Binding(
            get: { session.terminalDrafts[terminalID] ?? "" },
            set: { session.setDraft($0, terminalID: terminalID) })
        )
        .frame(height: verticalSizeClass == .compact ? 36 : 70)
        Button(showStop ? (stopping ? "停止中…" : "Stop") : (controller.inputBusy ? "发送中…" : "发送")) {
          failure = nil
          let stop = showStop
          if stop { stopping = true }
          Task {
            defer { stopping = false }
            do {
              if stop {
                try await session.stopCommand(terminalID)
              } else {
                try await session.sendCommand(terminalID: terminalID)
              }
            } catch {
              if !(error is CancellationError) {
                failure = stop ? displayError(error) : displayInputError(error)
              }
            }
          }
        }
        .disabled(
          !session.canWrite || !controller.canSend || stopping || (!showStop && !hasText)
        )
      }
    }.padding(.horizontal)
  }
}
