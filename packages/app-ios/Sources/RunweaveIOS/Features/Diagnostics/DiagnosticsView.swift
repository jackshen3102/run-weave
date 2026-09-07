import SwiftUI
import UIKit

private struct DiagnosticExport: Identifiable {
  let url: URL
  var id: URL { url }
}
struct DiagnosticsView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @State private var status: DiagnosticStatus?
  @State private var serverFile: String?
  @State private var failure: String?
  @State private var busy = false
  @State private var export: DiagnosticExport?
  @State private var operation: Task<Void, Never>?
  @State private var confirmClear = false
  @State private var storageWarning: String?
  @State private var recordCount = 0

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("诊断记录")) {
          Text("当前连接本地记录：\(recordCount) 条")
          Text(status?.status == "recording" ? "记录中" : status?.status == "ended" ? "已结束" : "可记录")
          if let started = status?.startedAt { Text(started).font(.caption) }
          Button("开始记录") {
            run { status = try await session.withConnection { try await $0.startDiagnostics() } }
          }
          .disabled(!session.canWrite || busy || status?.status == "recording")
          Button("停止并收集") {
            run {
              guard let started = status?.startedAt else { throw APIError.invalidResponse }
              let records = await collect().filter { $0.at >= started }
              let value = try await session.withConnection {
                try await $0.stopDiagnostics(records: records)
              }
              status = DiagnosticStatus(status: "ended", startedAt: nil)
              serverFile = value.files?.logsJsonl ?? value.files?.dir
            }
          }.disabled(!session.canWrite || busy || status?.status != "recording")
          Button("导出本地诊断") {
            run {
              let records = await collect()
              let data = try JSONEncoder().encode(records)
              let file = FileManager.default.temporaryDirectory.appendingPathComponent(
                "native-diagnostics-\(UUID().uuidString).json")
              try data.write(to: file, options: .atomic)
              export = DiagnosticExport(url: file)
            }
          }.disabled(busy)
          Button("清空本地诊断", role: .destructive) { confirmClear = true }.disabled(busy)
        }
        if let storageWarning { Section { Text(storageWarning).foregroundColor(.orange) } }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        if let serverFile {
          Section(header: Text("后端日志位置")) {
            Text(serverFile).textSelection(.enabled)
            Button("复制日志路径") { UIPasteboard.general.string = serverFile }
          }
        }
      }
      .navigationTitle("诊断").navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("关闭") { dismiss() } }
      .task {
        _ = await collect()
        do { status = try await session.withConnection { try await $0.diagnosticStatus() } } catch {
          if !Task.isCancelled { failure = displayError(error) }
        }
      }
      .onDisappear { operation?.cancel() }
      .confirmationDialog("清空当前连接的本地诊断记录？", isPresented: $confirmClear) {
        Button("清空", role: .destructive) {
          run {
            let api = session.api
            let controller = session.terminalController
            try await api?.clearDiagnosticRecords()
            controller?.clearDiagnosticEvents()
            recordCount = 0
            storageWarning = nil
          }
        }
      }
      .sheet(item: $export, onDismiss: { export = nil }) { file in
        DiagnosticShare(url: file.url).onDisappear {
          try? FileManager.default.removeItem(at: file.url)
        }
      }
    }.navigationViewStyle(.stack)
  }
  private func run(_ action: @escaping () async throws -> Void) {
    busy = true
    failure = nil
    operation = Task {
      do { try await action() } catch { if !Task.isCancelled { failure = displayError(error) } }
      busy = false
    }
  }
  private func collect() async -> [DiagnosticRecord] {
    guard let api = session.api else { return [] }
    let snapshot = await api.diagnosticSnapshot()
    storageWarning = snapshot.persistenceError
    recordCount = snapshot.records.count
    return snapshot.records.sorted { $0.at < $1.at }
  }
}
private struct DiagnosticShare: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
