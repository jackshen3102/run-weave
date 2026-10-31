import Foundation

struct RecordingSettings: Codable, Equatable {
    var interval: Double = 10
    var height: Int = 1080
    var retentionDays: Int = 7
    var maxGiB: Int = 10
    var excludedApplications: [String] = []
    var desiredRecording = false
    var privacyRevision = 1
    func validated() throws -> Self {
        guard [1.0, 5, 10, 20, 30, 60].contains(interval), [720, 1080].contains(height),
              (1...30).contains(retentionDays), (1...100).contains(maxGiB) else { throw journalError("invalid_settings") }
        var result = self
        result.excludedApplications = Array(Set(excludedApplications.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })).sorted()
        guard result.excludedApplications.count <= 1000,
              result.excludedApplications.allSatisfy({ $0.count <= 255 && !$0.contains(where: { $0.isWhitespace }) }) else { throw journalError("invalid_application_identifier") }
        return result
    }
    static func load(_ paths: StorePaths) throws -> Self {
        let url = try paths.file("settings.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            var settings = Self(); settings.excludedApplications = PrivacyFilter.initialIdentifiers()
            try paths.write(settings, to: "settings.json"); return settings
        }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url)).validated()
    }
}
