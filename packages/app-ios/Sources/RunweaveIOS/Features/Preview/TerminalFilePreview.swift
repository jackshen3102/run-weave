import SwiftUI

struct TerminalFilePreview: View {
  @ObservedObject var session: AppSession
  let terminalID: String
  let projectID: String
  let tap: TerminalFileTap
  let close: () -> Void
  @ObservedObject var model: ProjectChangesModel
  @State private var candidates: [TerminalFileCandidate] = []
  @State private var reference: TerminalFileReference?
  @State private var selected: TerminalFileCandidate?
  @State private var failure: String?
  @State private var loading = true

  var body: some View {
    NavigationView {
      Group {
        if let selected {
          FilePreview(session: session, projectID: projectID,
            file: SelectedFile(path: selected.path, readonly: selected.base == "filesystem"), model: model,
            targetLine: reference?.line, targetColumn: reference?.column, onClose: close)
        } else if let failure {
          Text(failure).foregroundColor(.secondary).padding()
            .accessibilityIdentifier("terminal-file-link-error")
        } else if loading {
          ProgressView("正在查找文件…")
        } else {
          List(candidates) { candidate in
            Button { selected = candidate } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(candidate.path)
                Text(candidate.absolutePath).font(.caption).foregroundColor(.secondary)
              }
            }
          }
        }
      }
      .navigationTitle(selected == nil ? "选择文件" : (selected!.path as NSString).lastPathComponent)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭", action: close) } }
    }
    .navigationViewStyle(.stack)
    .task { await resolve() }
  }

  private func resolve() async {
    guard let api = session.api else { failure = "当前连接不可用"; loading = false; return }
    do {
      let workspace = try await api.terminalFileWorkspace(terminalID: terminalID)
      try Task.checkCancellation()
      var panelID: String?
      var target = tap.reference()
      if workspace.panels.count > 1 {
        guard let panel = workspace.panels.first(where: { panel in
          guard let g = panel.geometry, g.windowWidth == tap.cols, g.windowHeight <= tap.rows else { return false }
          return tap.col >= g.paneLeft && tap.col < g.paneLeft + g.paneWidth
            && tap.viewportRow >= g.paneTop && tap.viewportRow < g.paneTop + g.paneHeight
        }) else { failure = "终端分屏布局已变化，请重新点击文件。"; loading = false; return }
        panelID = panel.panelId
        target = tap.reference(geometry: panel.geometry)
      } else if let id = workspace.panels.first?.panelId, id != "default" { panelID = id }
      guard let target else { failure = "无法识别此文件路径"; loading = false; return }
      let response = try await api.resolveTerminalFile(projectID: projectID, terminalID: terminalID,
        path: target.path, panelID: panelID, context: target.context)
      try Task.checkCancellation()
      reference = target
      candidates = response.candidates
      if candidates.count == 1 { selected = candidates[0] }
      else if candidates.isEmpty { failure = "文件不存在，或路径不在项目范围内。" }
      loading = false
    } catch is CancellationError {} catch {
      if case APIError.http(404) = error { failure = "文件不存在，或路径不在项目范围内。" }
      else if case APIError.http(409) = error { failure = "终端上下文已变化，请重新点击文件。" }
      else { failure = displayError(error) }
      loading = false
    }
  }
}
