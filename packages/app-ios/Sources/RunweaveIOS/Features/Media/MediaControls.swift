import SwiftUI

struct MediaControls: View {
  @ObservedObject var session: AppSession
  let terminalID: String
  let visible: Bool
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var recorder = VoiceRecorder()
  @State private var picking = false
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
      HStack {
        Button("图片") { picking = true }.disabled(busy || recorder.recording || !session.canWrite)
        if recorder.recording {
          Button("结束并转写") {
            do {
              let clip = try recorder.finish()
              submit { try await $0.transcribe(clip) }
            } catch { failure = displayError(error) }
          }.disabled(busy || !session.canWrite)
          Button("取消录音", role: .cancel) { recorder.cancel() }
        } else {
          Button(recorder.requestingPermission ? "请求麦克风…" : "录音") {
            Task { await recorder.start() }
          }.disabled(busy || recorder.requestingPermission || !session.canWrite)
        }
        if busy { ProgressView() }
        Spacer()
      }
    }
    .sheet(isPresented: $picking) {
      ImagePicker { result in
        picking = false
        guard active, scope == session.connection?.scope else { return }
        switch result {
        case .success(let value):
          if let (data, type) = value {
            submit { try await $0.uploadImage(terminalID: terminalID, data: data, mimeType: type) }
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

  private func submit(_ action: @escaping (APIClient) async throws -> String) {
    guard session.canWrite, active, scope == session.connection?.scope else { return }
    busy = true
    failure = nil
    operation = Task {
      do {
        let text = try await session.withConnection(action)
        guard active, !Task.isCancelled, scope == session.connection?.scope else { return }
        session.appendDraft(text, terminalID: terminalID)
      } catch { if !Task.isCancelled { failure = displayError(error) } }
      busy = false
    }
  }
}
