import Foundation
import Darwin

enum JournalError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
func journalError(_ text: String) -> JournalError { .message(text) }
let gib: Int64 = 1_073_741_824

struct StorePaths {
    let root: URL
    let validation: Bool
    var maxBytesOverride: Int64?
    var freeBytesOverride: Int64?
    static var standard: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ScreenJournal")
    }
    init(root: URL, validation: Bool = false, maxBytes: Int64? = nil, freeBytes: Int64? = nil) throws {
        self.root = root.standardizedFileURL
        self.validation = validation
        maxBytesOverride = maxBytes; freeBytesOverride = freeBytes
        // Reject every existing symlink component, including intermediate directories.
        var current = self.root
        while current.path != "/" {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: current.path),
               attrs[.type] as? FileAttributeType == .typeSymbolicLink { throw journalError("unsafe_symlink: \(current.path)") }
            current.deleteLastPathComponent()
        }
        if validation && (self.root.path == Self.standard.standardizedFileURL.path || self.root.path.hasPrefix(Self.standard.standardizedFileURL.path + "/")) { throw journalError("validation_requires_isolated_directory") }
    }
    func file(_ relative: String) throws -> URL {
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !relative.hasPrefix("/"), !components.contains(".."), !components.contains("."), !components.contains("") else {
            throw journalError("unsafe_relative_path")
        }
        var result = root
        for component in components {
            result.appendPathComponent(String(component))
            if let attrs = try? FileManager.default.attributesOfItem(atPath: result.path),
               attrs[.type] as? FileAttributeType == .typeSymbolicLink { throw journalError("unsafe_symlink") }
        }
        return result
    }
    func prepare() throws {
        for name in ["", "media", "pending", "runtime", "logs"] {
            let url = name.isEmpty ? root : try file(name)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        }
    }
    func usage() throws -> Int64 {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey], options: []) else { throw journalError("cannot_enumerate_store") }
        var bytes: Int64 = 0
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { throw journalError("unsafe_symlink") }
            if values.isRegularFile == true { bytes += Int64(values.fileSize ?? 0) }
        }
        return bytes
    }
    func freeBytes() throws -> Int64 {
        if let value = freeBytesOverride { return value }
        let attrs = try FileManager.default.attributesOfFileSystem(forPath: root.path)
        guard let value = attrs[.systemFreeSize] as? NSNumber else { throw journalError("free_space_unknown") }
        return value.int64Value
    }
    func write<T: Encodable>(_ value: T, to relative: String) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let url = try file(relative)
        try encoder.encode(value).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try syncFile(url)
    }
}
func syncFile(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw journalError("open_for_sync_failed") }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw journalError("fsync_failed") }
}
