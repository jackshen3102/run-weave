import Foundation
import CryptoKit

/// Same-user, read-only owner evidence. No pairing, capture, permission requests or credentials.
@MainActor
enum HostRuntimeStatus {
    private static let instanceID = "remote-desktop-host:\(ProcessInfo.processInfo.processIdentifier):\(UUID().uuidString.lowercased())"
    private static let runningHash = executableHash()
    private static var lastPublished: TimeInterval = 0

    private static func executableHash() -> String? {
        guard let url = Bundle.main.executableURL, let bytes = try? Data(contentsOf: url) else { return nil }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    static func initialize() { _ = runningHash }

    static func publish(_ model: HostModel) {
        guard !HostRuntime.simulatorLoopback else { return }
        let now = Date().timeIntervalSince1970
        guard now - lastPublished >= 5 else { return }
        lastPublished = now
        let time = Int64(now * 1000)
        let enabled = model.sharingEnabled || model.listenerFailed
        func fact(_ id: String, _ label: String, _ value: String) -> [String: Any] {
            ["id": id, "label": label, "value": value, "kind": "text", "copyable": true]
        }
        func item(_ id: String, _ label: String, _ state: String, _ summary: String, _ facts: [[String: Any]] = []) -> [String: Any] {
            ["id": "remote-desktop-host.\(id)", "capabilityId": "desktop", "label": label, "state": enabled ? state : "disabled",
             "summary": enabled ? summary : "RemoteDesk 共享未启用，不检查健康状态", "observedAt": time, "dependsOn": [], "recovery": NSNull(), "navigation": NSNull(), "facts": facts]
        }
        var versionFacts = [fact("runtime-version.number", "版本", Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown")]
        if let runningHash { versionFacts.append(fact("runtime-version.content", "产物摘要", runningHash)) }
        let installedHash = enabled ? executableHash() : nil
        versionFacts.append(fact("runtime-installation.state", "安装对照", runningHash == nil || installedHash == nil ? "unknown" : runningHash == installedHash ? "current" : "restart-required"))
        if let installedHash { versionFacts.append(fact("runtime-installation.content", "安装产物摘要", installedHash)) }
        let report: [String: Any] = [
            "protocolVersion": 1, "target": ["kind": "local-host"],
            "source": ["id": "remote-desktop-host", "runtime": "remote-desktop-host", "instanceId": instanceID, "capabilityId": "desktop"],
            "observedAt": time, "validForMs": 20000,
            "items": [
                item("process", "RemoteDesk Host", "healthy", "原生 Host 进程可响应；手机画面和控制需单独验证", versionFacts),
                item("listener", "RemoteDesk 监听", model.listenerFailed ? "unhealthy" : model.isRunning ? "healthy" : model.sharingEnabled ? "recovering" : "disabled", model.listenerFailed ? "局域网监听失败，请在本机检查接口和端口" : model.isRunning ? "局域网监听已就绪" : model.sharingEnabled ? "正在恢复局域网监听" : "共享已停止"),
                item("screen-permission", "屏幕录制权限", model.screenAllowed ? "healthy" : "unconfigured", model.screenAllowed ? "允许读取屏幕" : "需要在本机授权才能观看桌面"),
                item("control-permission", "辅助功能权限", !model.devices.contains(where: { $0.controlAllowed }) ? "disabled" : model.accessibilityAllowed ? "healthy" : "unconfigured", !model.devices.contains(where: { $0.controlAllowed }) ? "未启用键鼠控制，不检查辅助功能权限" : model.accessibilityAllowed ? "允许控制桌面" : "当前仅可只读观看")
            ]
        ]
        do {
            let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/RemoteDesk", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = root.appendingPathComponent("runtime-status.json")
            let temporary = root.appendingPathComponent("runtime-status-\(UUID().uuidString).tmp")
            defer { try? FileManager.default.removeItem(at: temporary) }
            let data = try JSONSerialization.data(withJSONObject: report)
            guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]),
                  rename(temporary.path, file.path) == 0 else { return }
        } catch { /* Reporting must not interrupt sharing. Missing/stale evidence stays visible to readers. */ }
    }
}
