import Foundation

extension AppSession {
  func refreshHomeConversationPreviews(ids: [String]) async {
    guard authenticated, foreground, health.status == .online, terminal == nil, let api else { return }
    let epoch = generation
    let revision = overviewRevision
    let targets = overview?.sessions.filter { ids.contains($0.id) && $0.conversationKey != nil } ?? []
    guard !targets.isEmpty else { return }
    let requestedKeys = Dictionary(uniqueKeysWithValues: targets.compactMap { target in
      target.conversationKey.map { (target.id, $0) }
    })
    let response: HomeConversationPreviewsResponse
    var failed = false
    do {
      response = try await api.homeConversationPreviews(ids: targets.map(\.id))
    } catch {
      if isRequestCancellation(error) || Task.isCancelled { return }
      failed = true
      response = HomeOverviewEventPatcher.failedConversationPreviews(for: targets)
    }
    guard generation == epoch,
      foreground, terminal == nil, revision == overviewRevision, !Task.isCancelled, var value = overview else { return }
    let needsOverviewReload = HomeOverviewEventPatcher.patchConversationPreviews(
      response, into: &value, requestedKeys: failed ? nil : requestedKeys)
    overview = value
    if needsOverviewReload { scheduleReload() }
  }
}
