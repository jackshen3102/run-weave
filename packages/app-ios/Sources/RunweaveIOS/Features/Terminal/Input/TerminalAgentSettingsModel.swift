import Combine
import Foundation

@MainActor
final class TerminalAgentSettingsModel: ObservableObject {
  enum Page { case input, models, efforts }

  @Published private(set) var response: TerminalAgentSettingsResponse?
  @Published private(set) var page: Page = .input
  @Published private(set) var selectedModelID: String?
  @Published private(set) var loading = false
  @Published private(set) var saving = false
  @Published private(set) var error: String?

  var selectedModel: TerminalAgentModelOption? {
    response?.models.first { $0.id == selectedModelID }
  }
  var summary: String? {
    guard let response else { return nil }
    let label = response.models.first { $0.id == response.settings.model }?.label
      ?? response.settings.model
    return "\(label) · \(Self.effortLabel(response.settings.reasoningEffort))"
  }

  static func effortLabel(_ effort: String?) -> String {
    switch effort {
    case "minimal": "极低"
    case "low": "低"
    case "medium": "中"
    case "high": "高"
    case "xhigh": "很高"
    case "max": "最大"
    case "ultra": "极限"
    case nil: "未设置"
    default: effort ?? "未设置"
    }
  }

  func refresh(session: AppSession, terminalID: String) async {
    guard let api = session.api, session.terminal?.id == terminalID else { return }
    let generation = session.generation
    if response == nil { loading = true }
    defer { loading = false }
    do {
      let next = try await api.terminalAgentSettings(id: terminalID)
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID,
        next.settings.terminalSessionId == terminalID else { return }
      if !saving {
        response = next
        if page == .input { error = nil }
      }
    } catch {
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID else { return }
      if let failure = error as? TerminalAgentSettingsFailure,
        failure.code == "agent_settings_unavailable" {
        response = nil
      } else if page != .input {
        self.error = displayError(error)
      }
    }
  }

  func showModels() {
    guard response != nil, !saving else { return }
    selectedModelID = response?.settings.model
    error = nil
    page = .models
  }

  func selectModel(_ id: String) {
    guard response?.models.contains(where: { $0.id == id }) == true, !saving else { return }
    selectedModelID = id
    error = nil
    page = .efforts
  }

  func back() {
    guard !saving else { return }
    if page == .efforts { page = .models }
    else { exit() }
  }

  func exit() {
    guard !saving else { return }
    page = .input
    selectedModelID = nil
    error = nil
  }

  func save(effort: String, session: AppSession, terminalID: String) async {
    guard !saving, let original = response?.settings, let model = selectedModel,
      model.reasoningEfforts.contains(effort), let api = session.api,
      session.terminal?.id == terminalID else { return }
    let generation = session.generation
    saving = true
    error = nil
    defer { saving = false }
    do {
      let next = try await api.updateTerminalAgentSettings(
        id: terminalID, settings: original, model: model.id, effort: effort)
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID,
        next.settings.terminalSessionId == terminalID,
        next.settings.threadId == original.threadId,
        next.settings.provider == original.provider else { return }
      response = next
      page = .input
      selectedModelID = nil
    } catch {
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID else { return }
      self.error = displayError(error)
      // Keep the user's model choice visible. A fresh snapshot resolves a stale revision.
      if let latest = try? await api.terminalAgentSettings(id: terminalID),
        session.generation == generation, session.api === api,
        session.terminal?.id == terminalID {
        response = latest
      }
    }
  }
}
