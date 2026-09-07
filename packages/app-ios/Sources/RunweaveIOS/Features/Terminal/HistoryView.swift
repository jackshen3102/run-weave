import SwiftUI
import UIKit

@MainActor
private final class HistoryModel: ObservableObject {
  @Published var surface: SwiftTermSurface?
  @Published var details: TerminalDetails?
  @Published var failure: String?

  func load(session: AppSession, id: String) async {
    do {
      let value = try await session.withConnection { try await $0.history(id: id) }
      guard !Task.isCancelled else { return }
      details = value
      let surface = SwiftTermSurface(
        scrollback: max(5000, value.scrollback.filter { $0 == "\n" }.count + 17))
      surface.terminalView.allowMouseReporting = false
      surface.terminalView.inputView = UIView(frame: .zero)
      surface.terminalView.accessibilityIdentifier = "terminal-history"
      self.surface = surface
      let normalized = value.scrollback.replacingOccurrences(
        of: "\r?\n", with: "\r\n", options: .regularExpression)
      // Feed in bounded chunks; the history surface has no socket or input callback.
      let bytes = Array(normalized.utf8)
      for offset in stride(from: 0, to: bytes.count, by: 16384) {
        guard !Task.isCancelled else { return }
        surface.feed(Array(bytes[offset..<min(offset + 16384, bytes.count)]))
        await Task.yield()
      }
      surface.terminalView.scroll(toPosition: 1)
    } catch { if !Task.isCancelled { failure = displayError(error) } }
  }
}

struct HistoryView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let terminalID: String
  @StateObject private var model = HistoryModel()
  @State private var copied = false

  var body: some View {
    NavigationView {
      VStack {
        if let details = model.details {
          let status =
            details.status == "exited"
            ? "已退出" + (details.exitCode.map { " (\($0))" } ?? "") : "运行中"
          Text("\(status) · \(details.cwd)")
            .font(.caption).lineLimit(2)
        }
        if let failure = model.failure { Text(failure).foregroundColor(.red) }
        if let surface = model.surface {
          TerminalHostView(surface: surface)
        } else if model.failure == nil {
          ProgressView("加载历史…")
        }
      }
      .navigationTitle(model.details?.alias ?? "终端历史")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("关闭") { dismiss() } }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button(copied ? "已复制" : "复制全部") {
            guard let view = model.surface?.terminalView else { return }
            view.selectAll(nil)
            view.copy(nil)
            copied = true
          }.disabled(model.surface == nil)
        }
      }
      .task { await model.load(session: session, id: terminalID) }
      .onDisappear { model.surface?.dispose() }
    }.navigationViewStyle(.stack)
  }
}
