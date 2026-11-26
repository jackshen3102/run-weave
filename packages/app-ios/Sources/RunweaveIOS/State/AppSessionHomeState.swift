import Foundation

extension AppSession {
  var loading: Bool {
    get { home.loading }
    set { home.loading = newValue }
  }
  var overview: HomeOverview? {
    get { home.overview }
    set { home.replace(newValue) }
  }
  var attentionSnapshot: AttentionSnapshot? {
    get { home.attentionSnapshot }
    set { home.replaceAttention(newValue) }
  }
  var metadataWrites: Set<String> {
    get { home.metadataWrites }
    set { home.metadataWrites = newValue }
  }
  var acknowledgementWrites: Set<String> {
    get { home.acknowledgementWrites }
    set { home.acknowledgementWrites = newValue }
  }
  var bellMarkers: Set<String> {
    get { home.bellMarkers }
    set { home.bellMarkers = newValue }
  }
}
