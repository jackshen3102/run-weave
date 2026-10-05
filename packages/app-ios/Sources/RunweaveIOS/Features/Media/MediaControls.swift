import SwiftUI
import UniformTypeIdentifiers

struct MediaControls<Content: View>: View {
  let session: AppSession
  let terminalID: String
  let canWrite: Bool
  let visible: Bool
  @Binding var preventsDismissal: Bool
  @ViewBuilder let content: (AnyView, AnyView) -> Content
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var recorder = VoiceRecorder()
  @State private var picking = false
  @State private var pickingFile = false
  @State private var pickerGeneration = 0
  @State private var busy = false
  @State private var failure: String?
  @State private var showingFailure = false
  @State private var scope: String?
  @State private var active = false
  @State private var operation: Task<Void, Never>?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let failure = failure ?? recorder.failure {
        Button { showingFailure = true } label: {
          Text(failure).font(.caption).foregroundColor(.red).lineLimit(1)
        }.buttonStyle(.plain).accessibilityHint("查看完整错误")
      }
      content(AnyView(attachmentButton), AnyView(voiceButtons))
    }
    .alert("媒体操作失败", isPresented: $showingFailure) {
      Button("关闭", role: .cancel) {}
    } message: { Text(failure ?? recorder.failure ?? "") }
    .sheet(isPresented: $picking) {
      ImagePicker { result in
        picking = false
        guard active, pickerGeneration == session.generation, scope == session.connection?.scope
        else { return }
        switch result {
        case .success(let value):
          if let (data, type) = value {
            do {
              try session.attachmentDrafts.add(
                data: data, mimeType: type, terminalID: terminalID, session: session)
            } catch { failure = displayError(error) }
          }
        case .failure(let error): failure = displayError(error)
        }
      }
    }
    .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
      guard active, pickerGeneration == session.generation, scope == session.connection?.scope else { return }
      switch result {
      case .success(let urls): importFiles(urls)
      case .failure(let error): failure = displayError(error)
      }
    }
    .onAppear {
      active = visible
      scope = session.connection?.scope
      syncDismissalState()
    }
    .onDisappear {
      active = false
      operation?.cancel()
      recorder.cancel()
      preventsDismissal = false
    }
    .onChange(of: visible) { value in
      active = value
      if !value {
        operation?.cancel()
        recorder.cancel()
        busy = false
      }
      syncDismissalState()
    }
    .onChange(of: busy) { _ in syncDismissalState() }
    .onChange(of: recorder.recording) { _ in syncDismissalState() }
    .onChange(of: recorder.requestingPermission) { _ in syncDismissalState() }
    .onChange(of: scenePhase) {
      if $0 == .background {
        recorder.cancel()
        syncDismissalState()
      }
    }
  }

  private var attachmentButton: some View {
    Group {
      Button {
        failure = nil
        pickerGeneration = session.generation
        picking = true
      } label: {
        Label("添加图片", systemImage: "photo")
      }.accessibilityLabel("添加图片")
        .disabled(busy || recorder.recording || !canWrite)
      Button {
        failure = nil
        pickerGeneration = session.generation
        pickingFile = true
      } label: {
        Label("添加文件", systemImage: "doc.badge.plus")
      }.accessibilityLabel("添加文件")
        .disabled(busy || recorder.recording || !canWrite)
    }
  }

  private func importFiles(_ urls: [URL]) {
    busy = true
    failure = nil
    let generation = pickerGeneration
    operation = Task {
      defer { busy = false }
      for url in urls {
        do {
          let file = try await Task.detached(priority: .userInitiated) {
            try ImportedTerminalFile.read(url)
          }.value
          guard !Task.isCancelled, active, generation == session.generation,
            scope == session.connection?.scope else { return }
          try session.attachmentDrafts.addFile(data: file.data, fileName: file.name, terminalID: terminalID, session: session)
        } catch {
          if !Task.isCancelled { failure = displayError(error) }
          return
        }
      }
    }
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
        }.accessibilityLabel("结束并转写").disabled(busy || !canWrite)
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
          .disabled(busy || recorder.requestingPermission || !canWrite)
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

  private func syncDismissalState() {
    preventsDismissal = visible && (busy || recorder.recording || recorder.requestingPermission)
  }
}
