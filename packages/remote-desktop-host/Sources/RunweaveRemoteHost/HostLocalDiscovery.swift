import Foundation

/// Public connection metadata for same-user local clients; never exports Keychain material.
enum HostLocalDiscovery {
    static func publish(running: Bool, address: String, port: UInt16, fingerprint: String) throws {
        guard !HostRuntime.simulatorLoopback else { return }
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/RemoteDesk", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "pid": ProcessInfo.processInfo.processIdentifier,
            "running": running, "localAddress": address, "localPort": port,
            "certificateFingerprint": fingerprint
        ])
        try data.write(to: directory.appendingPathComponent("local-host.json"), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600],
            ofItemAtPath: directory.appendingPathComponent("local-host.json").path)
    }
}
