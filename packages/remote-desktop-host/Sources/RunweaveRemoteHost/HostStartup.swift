import Foundation

/// An explicit local launch request uses the same service lifecycle as the UI.
/// No pairing approval, screen permission or input is granted by this entrypoint.
@MainActor
enum HostStartup {
    private static func argument(_ flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count,
              !arguments[index + 1].hasPrefix("--") else { return nil }
        return arguments[index + 1]
    }

    static func run(model: HostModel) async {
        guard ProcessInfo.processInfo.arguments.contains("--start-service") else { return }
        let interface = argument("--interface") ?? UserDefaults.standard.string(forKey: HostRuntime.interfacePreferenceKey)
        guard let interface, !interface.isEmpty else {
            model.status = "自动启动失败：首次使用请指定 --interface。"
            report(model: model, state: "failed")
            return
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        var attempted = false
        while !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline {
            if !attempted, model.interfaceNames.contains(interface) {
                model.selectedInterface = interface
                model.start()
                attempted = true
            }
            if model.isRunning {
                report(model: model, state: "ready")
                return
            }
            if attempted, !model.sharingEnabled {
                report(model: model, state: "failed")
                return
            }
            do { try await Task.sleep(nanoseconds: 100_000_000) }
            catch { return }
        }
        guard !Task.isCancelled else { return }
        await model.stop()
        model.status = "自动启动超时：请检查接口 \(interface) 的网络连接与监听状态。"
        report(model: model, state: "failed")
    }

    private static func report(model: HostModel, state: String) {
        guard let path = argument("--startup-result") else { return }
        let result: [String: Any] = [
            "schemaVersion": 1,
            "requestID": argument("--startup-request-id") ?? "",
            "state": state,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "appPath": Bundle.main.bundleURL.resolvingSymlinksInPath().path,
            "interface": model.selectedInterface,
            "address": model.endpointAddress,
            "port": model.port,
            "hostID": model.hostID?.uuidString ?? "",
            "screenPermission": model.screenAllowed,
            "controlPermission": model.accessibilityAllowed,
            "message": model.status,
            "remoteSessionVerified": false
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            model.status = "启动回执写入失败：\(error.localizedDescription)"
        }
    }
}
