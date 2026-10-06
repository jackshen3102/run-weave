// Local lifecycle CLI; uses application APIs, never UI automation or a LAN admin endpoint.
import AppKit
import Foundation

func emit(_ result: [String: Any], exitCode: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(exitCode)
}
func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["schemaVersion": 1, "state": "failed", "message": message], exitCode: code)
}
func waitUntil(seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    while !condition(), ProcessInfo.processInfo.systemUptime < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return condition()
}

var arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--inspect"] {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.runweave.remote-host")
    emit(["applications": apps.map { app -> [String: Any] in
        ["pid": app.processIdentifier,
         "appPath": app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path ?? ""]
    }], exitCode: 0)
}
let stopOnly = arguments.first == "--stop"
if stopOnly { arguments.removeFirst() }
guard arguments.count == 2 || arguments.count == 3 else {
    fail("Usage: start-host [--stop] <RemoteDesk.app> <evidence-directory> [interface] | --inspect", code: 2)
}
let appURL = URL(fileURLWithPath: arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
let evidenceURL = URL(fileURLWithPath: arguments[1]).standardizedFileURL
let requestID = UUID().uuidString
let receiptURL = evidenceURL.appendingPathComponent("startup-\(requestID).json")
guard let bundle = Bundle(url: appURL), bundle.bundleIdentifier == "com.runweave.remote-host",
      let executable = bundle.executableURL, FileManager.default.isExecutableFile(atPath: executable.path) else {
    fail("Expected a built com.runweave.remote-host application at \(appURL.path).", code: 2)
}
do { try FileManager.default.createDirectory(at: evidenceURL, withIntermediateDirectories: true) }
catch { fail("Cannot create evidence directory: \(error.localizedDescription)", code: 2) }

let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.runweave.remote-host")
for app in running {
    guard app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == appURL else {
        fail("Another checkout of RemoteDesk is running (PID \(app.processIdentifier)); it was left unchanged.")
    }
}
for app in running {
    // NSRunningApplication sends a normal quit request so HostAppDelegate can
    // release input, end sessions and finish capture before the process exits.
    guard app.terminate(), waitUntil(seconds: 10, { app.isTerminated }) else {
        fail("RemoteDesk PID \(app.processIdentifier) did not quit gracefully; no force kill or replacement launch was attempted.")
    }
}
if stopOnly {
    emit(["schemaVersion": 1, "state": "stopped", "appPath": appURL.path,
          "previousPIDs": running.map(\.processIdentifier)], exitCode: 0)
}

let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
configuration.arguments = ["--start-service", "--startup-result", receiptURL.path, "--startup-request-id", requestID]
if arguments.count == 3 { configuration.arguments += ["--interface", arguments[2]] }
var launched: NSRunningApplication?
var launchError: Error?
var launchFinished = false
NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
    launched = app; launchError = error; launchFinished = true
}
guard waitUntil(seconds: 15, { launchFinished }), let process = launched else {
    fail("Application launch failed: \(launchError?.localizedDescription ?? "launch timed out").")
}
var receipt: [String: Any]?
let answered = waitUntil(seconds: 20) {
    if let data = try? Data(contentsOf: receiptURL),
       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       parsed["requestID"] as? String == requestID {
        receipt = parsed
        return true
    }
    return process.isTerminated
}
guard answered, var result = receipt else {
    fail("RemoteDesk PID \(process.processIdentifier) did not return a startup receipt; inspect the application. Evidence: \(evidenceURL.path)")
}
guard result["pid"] as? Int32 == process.processIdentifier,
      result["appPath"] as? String == appURL.path, !process.isTerminated else {
    fail("Startup receipt does not match the newly launched process.")
}
result["receiptPath"] = receiptURL.path
result["previousPIDs"] = running.map(\.processIdentifier)
result["remoteSessionVerified"] = false
emit(result, exitCode: result["state"] as? String == "ready" ? 0 : 1)
