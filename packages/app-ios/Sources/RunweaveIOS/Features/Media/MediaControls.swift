import SwiftUI

struct MediaControls<Content: View>: View {
  @ObservedObject var session: AppSession
  let terminalID: String
  let visible: Bool
  @ViewBuilder let content: (AnyView, AnyView) -> Content
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var recorder = VoiceRecorder()
  @State private var picking = false
  @State private var pickerGeneration = 0
  @State private var busy = false
  @State private var failure: String?
  @State private var scope: String?
  @State private var active = false
  @State private var operation: Task<Void, Never>?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let failure = failure ?? recorder.failure {
        Text(failure).font(.caption).foregroundColor(.red)
      }
      content(AnyView(attachmentButton), AnyView(voiceButtons))
    }
    .sheet(isPresented: $picking) {
      ImagePicker { result in
        picking = false
        guard active, pickerGeneration == session.generation, scope == session.connection?.scope
        else { return }
        switch result {
        case .success(let value):
          if let (data, type) = value {
            do {
              try session.imageDrafts.add(
                data: data, mimeType: type, terminalID: terminalID, session: session)
            } catch { failure = displayError(error) }
          }
        case .failure(let error): failure = displayError(error)
        }
      }
    }
    .onAppear {
      active = visible
      scope = session.connection?.scope
    }
    .onDisappear {
      active = false
      operation?.cancel()
      recorder.cancel()
    }
    .onChange(of: visible) { value in
      active = value
      if !value {
        operation?.cancel()
        recorder.cancel()
        busy = false
      }
    }
    .onChange(of: scenePhase) { if $0 == .background { recorder.cancel() } }
  }

  private var attachmentButton: some View {
    Button {
      failure = nil
      pickerGeneration = session.generation
      picking = true
    } label: {
      Image(systemName: "plus")
    }.accessibilityLabel("添加图片")
      .disabled(busy || recorder.recording || !session.canWrite)
  }

  private var voiceButtons: some View {
    HStack(spacing: 2) {
      if recorder.recording {
        Button {
          session.recordUserAction("voice.transcribe", terminalID: terminalID)
          do {
            let clip = try recorder.finish()
            submit { try await $0.transcribe(clip) }
          } catch { failure = displayError(error) }
        } label: {
          Image(systemName: "checkmark.circle.fill").foregroundColor(.red)
        }.accessibilityLabel("结束并转写").disabled(busy || !session.canWrite)
        Button(role: .cancel) {
          session.recordUserAction("voice.cancel", terminalID: terminalID)
          recorder.cancel()
        } label: {
          Image(systemName: "xmark")
        }.accessibilityLabel("取消录音")
      } else {
        Button {
          session.recordUserAction("voice.start", terminalID: terminalID)
          Task { await recorder.start() }
        } label: {
          if recorder.requestingPermission { ProgressView() } else { Image(systemName: "mic") }
        }.accessibilityLabel(recorder.requestingPermission ? "请求麦克风…" : "录音")
          .disabled(busy || recorder.requestingPermission || !session.canWrite)
      }
      if busy { ProgressView() }
    }
  }

  private func submit(_ action: @escaping (APIClient) async throws -> String) {
    guard session.canWrite, active, scope == session.connection?.scope else { return }
    busy = true
    failure = nil
    operation = Task {
      do {
        // Media owns its recoverable error; connection/auth transitions still belong to the session.
        let text = try await session.withConnection(reportFailure: false, action)
        guard active, !Task.isCancelled, scope == session.connection?.scope else { return }
        session.appendDraft(text, terminalID: terminalID)
      } catch { if !Task.isCancelled { failure = displayError(error) } }
      busy = false
    }
  }
}
