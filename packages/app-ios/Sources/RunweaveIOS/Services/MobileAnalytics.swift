import Clarity
import Foundation

@MainActor
public enum MobileAnalytics {
  public static func initialize() {
    let settings = Bundle.main.infoDictionary ?? [:]
    guard (settings["RunweaveClarityEnabled"] as? String) == "YES",
      let projectID = settings["RunweaveClarityProjectID"] as? String,
      !projectID.isEmpty,
      projectID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else { return }

    _ = ClaritySDK.initialize(config: ClarityConfig(projectId: projectID))
  }
}
