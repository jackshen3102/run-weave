import XCTest

extension XCUIElement {
  // Avoid the initial polling delay for an element that is already present.
  // Presence does not imply hittability; callers retain their interaction checks.
  @MainActor
  func waitUntilExists(timeout: TimeInterval) -> Bool {
    exists || waitForExistence(timeout: timeout)
  }
}

struct DeviceCase {
  let id: String
  var restartReason: String? = nil
  let precondition: (DeviceContext) throws -> Void
  let execute: (DeviceContext) throws -> Void
  let postcondition: (DeviceContext) throws -> Void
}

struct DeviceAssertion: Error, CustomStringConvertible {
  let description: String
}

@MainActor
final class DeviceContext {
  let app: XCUIApplication
  private let runner: BatchRunner
  init(app: XCUIApplication, runner: BatchRunner) { self.app = app; self.runner = runner }
  func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    let passed = condition()
    runner.emit("assertion", ["passed": passed, "message": message])
    if !passed { throw DeviceAssertion(description: message) }
  }
  func attach(_ name: String, _ text: String) {
    let attachment = XCTAttachment(string: text)
    attachment.name = name; attachment.lifetime = .keepAlways; runner.add(attachment)
  }
}

@MainActor
final class BatchRunner: XCTestCase {
  private var events: [[String: Any]] = []
  private var currentCase: String?
  private var issueRecorded = false
  private let runID = ProcessInfo.processInfo.environment["RUNWEAVE_RUN_ID"] ?? "missing"

  override func record(_ issue: XCTIssue) {
    issueRecorded = true
    super.record(issue)
  }

  func emit(_ kind: String, _ fields: [String: Any] = [:]) {
    var event = fields
    event["kind"] = kind; event["runId"] = runID
    event["sequence"] = events.count
    event["at"] = ISO8601DateFormatter().string(from: Date())
    if let id = currentCase { event["caseId"] = id }
    events.append(event)
    if let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) { print("RUNWEAVE_DEVICE_EVENT " + json) }
  }

  private func evidence(_ app: XCUIApplication, _ name: String) {
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = name + "-screen"; screenshot.lifetime = .keepAlways; add(screenshot)
  }

  func testBatch() throws {
    continueAfterFailure = true
    defer {
      if let data = try? JSONSerialization.data(withJSONObject: events, options: [.sortedKeys]),
         let text = String(data: data, encoding: .utf8) {
        let attachment = XCTAttachment(string: text)
        attachment.name = "batch-events"; attachment.lifetime = .keepAlways; add(attachment)
      }
    }
    guard runID != "missing" else { throw DeviceAssertion(description: "Missing run identity") }
    let available = DeviceSuite.cases()
    guard Set(available.map(\.id)).count == available.count,
          Selection.ids.allSatisfy({ id in available.contains(where: { $0.id == id }) }) else {
      throw DeviceAssertion(description: "Suite case registry does not match explicit selection")
    }
    let app = XCUIApplication(bundleIdentifier: "com.runweave.app.native")
    app.launchArguments = Selection.launchArguments
    // Launch arguments only apply to a declared cold start, never pretend activate applies them.
    if !Selection.launchArguments.isEmpty && !Selection.ids.allSatisfy({ id in
      available.first(where: { $0.id == id })?.restartReason != nil
    }) { throw DeviceAssertion(description: "Launch arguments require declared restart for every case") }
    emit("automation_probe_started")
    app.activate()
    guard app.wait(for: .runningForeground, timeout: 15), app.windows.firstMatch.waitUntilExists(timeout: 15) else {
      throw DeviceAssertion(description: "Target foreground/window unavailable")
    }
    evidence(app, "automation-ready")
    guard !issueRecorded else { throw DeviceAssertion(description: "Fresh target tree could not be read") }
    emit("automation_ready")
    let context = DeviceContext(app: app, runner: self)
    for id in Selection.ids {
      guard let item = available.first(where: { $0.id == id }) else { return }
      currentCase = id
      issueRecorded = false
      emit("case_started")
      var failure: String?
      XCTContext.runActivity(named: id) { _ in
        do {
          if let reason = item.restartReason {
            emit("app_restart", ["reason": reason])
            app.terminate(); app.launch()
          } else { app.activate() }
          try context.require(app.wait(for: .runningForeground, timeout: 15), "Target App is foreground")
          try item.precondition(context)
          if issueRecorded { throw DeviceAssertion(description: "XCTest precondition issue") }
          evidence(app, id + "-before")
          if issueRecorded { throw DeviceAssertion(description: "Precondition observation failed") }
          try item.execute(context)
          if issueRecorded { throw DeviceAssertion(description: "XCTest execution issue") }
          try item.postcondition(context)
        } catch { failure = String(describing: error) }
        evidence(app, id + "-after")
        if issueRecorded && failure == nil { failure = "XCTest recorded an issue" }
      }
      if let message = failure {
        emit("case_finished", ["status": "fail", "message": message])
        XCTFail(message)
        currentCase = nil
        emit("batch_finished", ["status": "fail"])
        return
      }
      emit("case_finished", ["status": "pass"])
      currentCase = nil
    }
    emit("batch_finished", ["status": "pass"])
  }
}
