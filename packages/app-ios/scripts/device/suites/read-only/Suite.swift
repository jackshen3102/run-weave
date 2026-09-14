import XCTest

@MainActor
enum DeviceSuite {
  // Each scene establishes its own navigation; no credentials or external writes.
  static func home(_ context: DeviceContext) throws {
    let app = context.app
    if app.navigationBars["连接管理"].exists && app.buttons["关闭"].exists { app.buttons["关闭"].tap() }
    if !app.buttons["连接管理"].waitUntilExists(timeout: 5), app.navigationBars.buttons["Runweave"].exists {
      app.navigationBars.buttons["Runweave"].tap()
    }
    try context.require(app.buttons["连接管理"].waitUntilExists(timeout: 10), "Home exposes connection management")
  }
  static func connections(_ context: DeviceContext) throws {
    try home(context)
    context.app.buttons["连接管理"].tap()
    try context.require(context.app.navigationBars["连接管理"].waitUntilExists(timeout: 5), "Connection manager is visible")
  }
  static func cases() -> [DeviceCase] {
    [
      DeviceCase(id: "HOME-001", precondition: home, execute: { context in
        try context.require(context.app.navigationBars["Runweave"].exists || context.app.navigationBars["Sign in"].exists, "Official home or sign-in navigation is present")
      }, postcondition: { context in try context.require(context.app.buttons["连接管理"].exists, "Home remains available") }),
      DeviceCase(id: "CONNECTIONS-002", precondition: connections, execute: { context in
        try context.require(context.app.buttons["关闭"].exists, "Connection manager can be dismissed")
        context.attach("connections-version", "read-only-v1")
      }, postcondition: { context in try context.require(context.app.navigationBars["连接管理"].exists, "Connection manager remains visible") }),
      DeviceCase(id: "RETURN-003", precondition: connections, execute: { context in context.app.buttons["关闭"].tap() },
        postcondition: { context in try context.require(context.app.buttons["连接管理"].waitUntilExists(timeout: 5), "Dismiss returns to home") }),
    ]
  }
}
