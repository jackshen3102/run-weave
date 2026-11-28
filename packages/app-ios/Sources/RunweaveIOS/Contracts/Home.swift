import Foundation

// Source: packages/shared/src/terminal/{runtime/session,project,project-context}.ts
struct HomeOverview: Codable, Equatable {
  var projects: [TerminalProject]
  var sessions: [HomeTerminal]
}

struct TerminalProject: Codable, Identifiable, Equatable {
  let projectId: String
  var name: String
  let path: String?
  let createdAt: String
  let isDefault: Bool
  var id: String { projectId }
}

// Source: packages/shared/src/terminal/project-context.ts
struct TerminalProjectContext: Decodable, Identifiable {
  let projectId: String
  let parentProjectId: String
  let name: String
  let branch: String?
  let path: String?
  let isPrimary: Bool
  let availability: String
  var id: String { projectId }
  // A parent without a configured path retains the default home-directory behavior.
  var canCreateTerminal: Bool {
    availability == "available" || (isPrimary && availability == "path_unavailable")
  }
}

struct TerminalState: Codable, Equatable {
  var state: String
  var agent: String?
}

struct TerminalProgramStatus: Codable, Equatable {
  let state: String
  let source: String
  let observedAt: String?
  let kind: String?

  var label: String? {
    switch state {
    case "starting": return "启动中"
    case "working": return "正在执行"
    case "idle": return "等待输入"
    case "blocked": return "需要输入"
    case "done": return "本轮结束"
    case "error": return "本轮失败"
    default: return nil
    }
  }
}

struct HomeTerminal: Codable, Identifiable, Equatable {
  let terminalSessionId: String
  var projectId: String
  var alias: String?
  var pinnedAt: String?
  var title: String
  var subtitle: String
  var conversationKey: String?
  var conversationPreview: HomeConversationPreview?
  // Local invalidation for an open reply assistant; cached Home text is historical.
  var conversationRevision: String?
  let command: String
  var activeCommand: String?
  var cwd: String
  var status: String
  var displayStatus: String
  var displayStatusLabel: String
  var terminalState: TerminalState
  var programStatus: TerminalProgramStatus? = nil
  var completionRevision: Int?
  var acknowledgedCompletionRevision: Int?
  let lastActivityAt: String
  var id: String { terminalSessionId }
  var hasUnreadCompletion: Bool {
    (completionRevision ?? 0) > (acknowledgedCompletionRevision ?? 0)
  }
  var isAgentActive: Bool {
    guard status != "exited" else { return false }
    if let programStatus { return ["working", "starting", "blocked"].contains(programStatus.state) }
    return terminalState.state == "agent_running" || terminalState.state == "agent_starting"
  }

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

struct HomeConversationPreview: Codable, Equatable {
  let threadId: String
  let provider: String
  let available: Bool
  var availability: String? = nil
  let turnId: String?
  let userText: String?
  let agentText: String?
}

struct HomeConversationPreviewsResponse: Decodable {
  struct Item: Decodable {
    let terminalSessionId: String
    let conversationKey: String
    let conversationPreview: HomeConversationPreview
  }
  let sessions: [Item]
}

struct TerminalOriginSource: Codable, Equatable, Hashable {
  let terminalSessionId: String
  let relation: String?
}

enum TerminalSessionSource: Codable, Equatable, Hashable {
  case scheduledTask(ScheduledTaskSource)
  case terminal(TerminalOriginSource)
  case unknown(String)

  var scheduledTask: ScheduledTaskSource? {
    if case .scheduledTask(let value) = self { return value }
    return nil
  }

  private enum CodingKeys: String, CodingKey {
    case type, taskId, runId, terminalSessionId, relation
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "scheduled-task":
      let taskId = try container.decode(String.self, forKey: .taskId)
      let runId = try container.decode(String.self, forKey: .runId)
      self = .scheduledTask(ScheduledTaskSource(type: type, taskId: taskId, runId: runId))
    case "terminal":
      let terminalSessionId = try container.decode(String.self, forKey: .terminalSessionId)
      let relation = try container.decodeIfPresent(String.self, forKey: .relation)
      self = .terminal(TerminalOriginSource(terminalSessionId: terminalSessionId, relation: relation))
    default:
      self = .unknown(type)
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .scheduledTask(let value):
      try container.encode(value.type, forKey: .type)
      try container.encode(value.taskId, forKey: .taskId)
      try container.encode(value.runId, forKey: .runId)
    case .terminal(let value):
      try container.encode("terminal", forKey: .type)
      try container.encode(value.terminalSessionId, forKey: .terminalSessionId)
      try container.encodeIfPresent(value.relation, forKey: .relation)
    case .unknown(let type):
      try container.encode(type, forKey: .type)
    }
  }
}

struct TerminalDetails: Decodable, Identifiable {
  var source: TerminalSessionSource? = nil
  let terminalSessionId: String
  var projectId: String
  var alias: String?
  let command: String
  let cwd: String
  let activeCommand: String?
  let status: String
  let exitCode: Int?
  let scrollback: String
  let scrollbackSourceCols: Int?
  var id: String { terminalSessionId }
}

// PATCH returns a session list item, without overview title/subtitle fields.
struct UpdatedTerminal: Decodable {
  let terminalSessionId: String
  let projectId: String
  let alias: String?
  let pinnedAt: String?
}

struct TerminalCompletionAcknowledgement: Decodable {
  let terminalSessionId: String
  let completionRevision: Int
  let acknowledgedCompletionRevision: Int
}

enum TerminalMetadataChange {
  case pinned(Bool)
  case alias(String?)
  case project(String)

  var body: [String: Any] {
    switch self {
    case .pinned(let value): return ["pinned": value]
    case .alias(let value): return ["alias": value as Any? ?? NSNull()]
    case .project(let value): return ["projectId": value]
    }
  }
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
    var sessionsByProject: [String: [HomeTerminal]] = [:]
    for terminal in sessions {
      sessionsByProject[Self.parentProjectID(terminal.projectId), default: []].append(terminal)
    }
    func matches(_ values: [String?]) -> Bool {
      values.contains {
        $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().contains(query) == true
      }
    }
    return projects.compactMap { project in
      let all = sessionsByProject[project.id] ?? []
      let projectMatches = query.isEmpty || matches([project.name, project.path])
      let visible =
        projectMatches
        ? all
        : all.filter { matches([$0.title, $0.subtitle, $0.conversationPreview?.userText,
          $0.conversationPreview?.agentText, $0.command, $0.activeCommand, $0.cwd]) }
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

// Source: packages/shared/src/terminal/project-context.ts
struct WorktreeCreatePreview: Decodable {
  struct Setup: Decodable {
    let command, cwd, revision: String
    let approved: Bool
  }
  let parentProjectId, defaultBaseRef: String
  let currentBranch: String?
  let branches, worktreeNames: [String]
  let setup: Setup?
}

struct WorktreeCreation: Decodable {
  let context: TerminalProjectContext
  let terminalSessionId, setupStatus: String
}
