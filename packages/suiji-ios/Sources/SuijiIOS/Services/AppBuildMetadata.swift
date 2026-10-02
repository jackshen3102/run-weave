import Foundation
import IOSBuildIdentity

// Read this installed bundle once, on demand. Never infer its identity from the connected Backend.
enum AppBuildMetadata {
  static let fields: [String: String] = {
    var fields = [
      "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
      "app_build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
      "build_id": "unknown",
      "source_revision": "unknown",
      "source_state": "unknown",
    ]
    if let identity = try? AppBuildIdentity.read().identity {
      fields["build_id"] = identity.buildId
      fields["source_revision"] = identity.sourceRevision ?? "unknown"
      fields["source_state"] = identity.sourceState
    }
    return fields
  }()
}
