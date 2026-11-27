import Combine
import Foundation

@MainActor
final class TerminalAgentSettingsModel: ObservableObject {
  enum Page { case input, models, efforts }

  @Published private(set) var response: TerminalAgentSettingsResponse?
  @Published private(set) var page: Page = .input
  @Published private(set) var selectedModelID: String?
  @Published private(set) var saving = false
  @Published private(set) var error: String?

  init(initial: TerminalAgentSettingsResponse? = nil) {
    self.response = initial
  }

  var commitsModelOnSelection: Bool { response?.settings.provider == "agy" }

  var summary: String? {
    guard let response else { return nil }
    guard let model = response.settings.model else { return "选择模型" }
    let name = response.models.first { $0.id == model }?.label ?? model
    let label = response.settings.modelSource == "default" ? "默认 · \(name)" : name
    if commitsModelOnSelection { return label }
    return "\(label) · \(Self.effortLabel(response.settings.reasoningEffort))"
  }

  var accessibilityLabel: String {
    guard let summary, let settings = response?.settings, settings.model != nil else { return "选择模型" }
    if settings.modelSource == "default" { return summary }
    return commitsModelOnSelection ? "当前终端模型：\(summary)" : "当前终端模型与推理强度：\(summary)"
  }

  static func effortLabel(_ effort: String?) -> String {
    AgentModelOption.effortLabel(effort)
  }

  func refresh(session: AppSession, terminalID: String) async {
    guard session.api != nil, session.terminal?.id == terminalID else { return }
    if response == nil, !saving,
      let cached = session.agentSettingsCache.cached(session: session, terminalID: terminalID) {
      response = cached
    }
    let generation = session.generation
    let api = session.api
    do {
      let next = try await session.agentSettingsCache.refresh(session: session, terminalID: terminalID)
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID,
        next.settings.terminalSessionId == terminalID else { return }
      if !saving {
        if response != next {
          response = next
          if page == .efforts, let id = selectedModelID,
            !next.models.contains(where: { $0.id == id }) {
            selectedModelID = nil
            page = .models
          }
        }
        if page == .input, error != nil { error = nil }
      }
    } catch {
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID else { return }
      if TerminalAgentSettingsStore.isAuthoritativelyUnavailable(error) {
        if !saving {
          if response != nil { response = nil }
          if page != .input { exit() }
        }
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

  func save(modelID: String, effort: String, session: AppSession, terminalID: String) async {
    guard !saving, let response, let api = session.api, session.terminal?.id == terminalID,
      let model = response.models.first(where: { $0.id == modelID }),
      commitsModelOnSelection ? page == .models : page == .efforts && selectedModelID == modelID,
      model.reasoningEfforts.contains(effort) else { return }
    let original = response.settings
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
        next.settings.panelId == original.panelId,
        next.settings.threadId == original.threadId,
        next.settings.provider == original.provider else { return }
      session.agentSettingsCache.store(next, session: session, terminalID: terminalID)
      self.response = next
      page = .input
      selectedModelID = nil
    } catch {
      guard !Task.isCancelled, session.generation == generation,
        session.api === api, session.terminal?.id == terminalID else { return }
      self.error = displayError(error)
      // A fresh snapshot lets the user retry with the latest revision.
      if let latest = try? await session.agentSettingsCache.refresh(session: session, terminalID: terminalID),
        session.generation == generation, session.api === api,
        session.terminal?.id == terminalID {
        self.response = latest
      }
    }
  }
}
