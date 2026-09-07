import Foundation

// Source: packages/shared/src/terminal/{runtime/session,project,project-context}.ts
struct HomeOverview: Codable {
  var projects: [TerminalProject]
  var sessions: [HomeTerminal]
}

struct TerminalProject: Codable, Identifiable {
  let projectId: String
  var name: String
  let path: String?
  let createdAt: String
  let isDefault: Bool
  var id: String { projectId }
}

struct TerminalState: Codable {
  var state: String
  var agent: String?
}

struct HomeTerminal: Codable, Identifiable {
  let terminalSessionId: String
  let projectId: String
  var title: String
  var subtitle: String
  let command: String
  var activeCommand: String?
  var cwd: String
  var status: String
  var displayStatus: String
  var displayStatusLabel: String
  var terminalState: TerminalState
  let lastActivityAt: String
  var id: String { terminalSessionId }

  var relativeTime: String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: lastActivityAt)
    if date == nil {
      formatter.formatOptions = [.withInternetDateTime]
      date = formatter.date(from: lastActivityAt)
    }
    guard let date else { return "" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
  }
}

struct TerminalDetails: Decodable, Identifiable {
  let terminalSessionId: String
  let projectId: String
  let alias: String?
  let command: String
  let cwd: String
  let activeCommand: String?
  let status: String
  let exitCode: Int?
  let scrollback: String
  let scrollbackSourceCols: Int?
  var id: String { terminalSessionId }
}

struct CreatedTerminal: Decodable {
  let terminalSessionId: String
  let terminalUrl: String
}
struct EventTicket: Decodable {
  let ticket: String
  let baselineEventId: String?
  let streamId: String
}

struct HomeGroup: Identifiable {
  let project: TerminalProject
  let sessions: [HomeTerminal]
  let terminalCount: Int
  var id: String { project.id }
}

extension HomeOverview {
  func groups(matching query: String) -> [HomeGroup] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    func matches(_ values: [String?]) -> Bool {
      values.contains {
        $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().contains(query) == true
      }
    }
    return projects.compactMap { project in
      let all = sessions.filter { Self.parentProjectID($0.projectId) == project.id }
      let projectMatches = query.isEmpty || matches([project.name, project.path])
      let visible =
        projectMatches
        ? all
        : all.filter { matches([$0.title, $0.subtitle, $0.command, $0.activeCommand, $0.cwd]) }
      guard projectMatches || !visible.isEmpty else { return nil }
      return HomeGroup(project: project, sessions: visible, terminalCount: all.count)
    }
  }

  static func parentProjectID(_ id: String) -> String {
    let parts = id.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == "wt" else { return id }
    func decode(_ value: String) -> String? {
      guard !value.isEmpty, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
      else { return nil }
      let padded =
        value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        + String(repeating: "=", count: (4 - value.count % 4) % 4)
      guard let data = Data(base64Encoded: padded), let text = String(data: data, encoding: .utf8)
      else { return nil }
      return text
    }
    func encode(_ value: String) -> String {
      Data(value.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    guard let parent = decode(parts[1]),
      !parent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let raw = decode(parts[2])
    else { return id }
    let name = raw.precomposedStringWithCanonicalMapping
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
      !name.contains("\0"),
      "wt:\(encode(parent.trimmingCharacters(in: .whitespacesAndNewlines))):\(encode(name))" == id
    else { return id }
    return parent
  }
}
