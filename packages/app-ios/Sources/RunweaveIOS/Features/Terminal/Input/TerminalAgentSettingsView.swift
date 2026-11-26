import SwiftUI

struct TerminalAgentSettingsView: View {
  @ObservedObject var model: TerminalAgentSettingsModel
  let session: AppSession
  let terminalID: String
  let height: CGFloat

  var body: some View {
    AgentModelSelectionView(
      models: model.response?.models ?? [],
      currentModelID: model.response?.settings.model,
      currentEffort: model.response?.settings.reasoningEffort,
      selectedModelID: Binding(get: {
        model.page == .efforts ? model.selectedModelID : nil
      }, set: { id in
        if let id { model.selectModel(id) } else { model.back() }
      }),
      commitsModelOnSelection: model.commitsModelOnSelection,
      saving: model.saving, error: model.error, identifierPrefix: "terminal-agent",
      onClose: { model.exit() },
      onSelect: { id, effort in
        guard let effort else { return }
        Task { await model.save(modelID: id, effort: effort, session: session, terminalID: terminalID) }
      }
    )
    .frame(height: height)
    .accessibilityIdentifier("terminal-agent-settings-list")
  }
}
