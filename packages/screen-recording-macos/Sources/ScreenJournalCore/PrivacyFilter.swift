// Sensitive-app matching adapted from Dayflow RecordingPrivacyPreferences.swift,
// 730d6f84b919998158ff7fdab15e3f032f7d8135. Copyright (c) 2025 Jerry Liu, MIT.
import AppKit
import ScreenCaptureKit

struct PrivacyFilter {
    static let secretNames: Set<String> = ["1password", "authy", "bitwarden", "dashlane", "enpass", "keeper", "keepassxc", "keychain access", "lastpass", "ledger live", "nordpass", "passwords", "proton pass", "secrets", "trezor suite", "yubico authenticator"]
    static let secretHints = ["1password", "authy", "bitwarden", "dashlane", "enpass", "keeper", "keepass", "keychainaccess", "lastpass", "ledger", "nordpass", "passwords", "protonpass", "secrets", "trezor", "yubico"]
    static func initialIdentifiers() -> [String] {
        var result = Set<String>()
        for path in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
            guard let files = FileManager.default.enumerator(at: URL(fileURLWithPath: path), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in files where url.pathExtension == "app" {
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { continue }
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent).lowercased()
                let compact = id.lowercased().filter { $0 != "." && $0 != "-" && $0 != "_" }
                if secretNames.contains(name) || secretHints.contains(where: { compact.contains($0) }) { result.insert(id.lowercased()) }
            }
        }
        return result.sorted()
    }
    @MainActor static func frontmostID() -> String? { NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased() }
    static func blocked(_ id: String?, settings: RecordingSettings) -> Bool {
        guard let id else { return false }; return settings.excludedApplications.contains(id.lowercased())
    }
    static func placeholder(width: Int, height: Int) throws -> CGImage {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw journalError("placeholder_allocation_failed") }
        context.setFillColor(CGColor(gray: 0.12, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setStrokeColor(CGColor(gray: 0.55, alpha: 1)); context.setLineWidth(8)
        let box = CGRect(x: width / 2 - 50, y: height / 2 - 45, width: 100, height: 80)
        context.stroke(box); context.strokeEllipse(in: CGRect(x: width / 2 - 30, y: height / 2 + 20, width: 60, height: 60))
        guard let image = context.makeImage() else { throw journalError("placeholder_render_failed") }; return image
    }
}
