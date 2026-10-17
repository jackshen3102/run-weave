import Foundation

extension AppSession {
  func refreshHomeConversationPreviews(ids: [String]) async {
    guard authenticated, foreground, health.status == .online, terminal == nil, let api else { return }
    let epoch = generation
    let revision = overviewRevision
    let targets = overview?.sessions.filter { ids.contains($0.id) && $0.conversationKey != nil } ?? []
    let response: HomeConversationPreviewsResponse
    do {
      response = try await api.homeConversationPreviews(ids: ids)
    } catch {
      if isRequestCancellation(error) || Task.isCancelled { return }
      response = HomeOverviewEventPatcher.failedConversationPreviews(for: targets)
    }
    guard generation == epoch,
      foreground, terminal == nil, revision == overviewRevision, !Task.isCancelled, var value = overview else { return }
    HomeOverviewEventPatcher.patchConversationPreviews(response, into: &value)
    overview = value
  }
}
