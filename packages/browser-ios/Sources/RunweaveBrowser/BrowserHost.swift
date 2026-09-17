import Foundation

public struct BrowserOpenIntent {
  public enum Origin { case host, selection, page }
  public enum Action { case internalOpen, externalOpen, link }
  public let target: String
  public let origin: Origin
  public let action: Action
  public let sessionIdentity: UUID?

  public init(target: String, origin: Origin, action: Action, sessionIdentity: UUID? = nil) {
    self.target = target
    self.origin = origin
    self.action = action
    self.sessionIdentity = sessionIdentity
  }
}

/// Opaque host identity. Components avoid delimiter collisions; no credentials belong here.
public struct BrowserContext: Equatable {
  public let scope: [String]
  public let generation: String

  public init(scope: [String], generation: String) {
    self.scope = scope
    self.generation = generation
  }
}

public struct BrowserPresentationConfiguration {
  public let applicationName: String
  public let returnLabel: String
  public let clearDataMessage: String

  public init(applicationName: String, returnLabel: String, clearDataMessage: String) {
    self.applicationName = applicationName
    self.returnLabel = returnLabel
    self.clearDataMessage = clearDataMessage
  }
}
