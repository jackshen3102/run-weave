import Foundation

// Wire contract in packages/shared/src/terminal/context-handoff.ts
struct ContextHandoffPreview: Decodable {
  struct Project: Decodable { let projectId, name: String }
  let sourceTerminalId, sourcePanelId, sourceProvider, sourceThreadId, sourceRevision, sourceProjectId: String
  let totalMessages, includedMessages, omittedMessages, includedTurns, partialTurns, omittedTurns, handoffBytes, budgetBytes: Int
  let canNativeCodexFork: Bool
  let targetProjects: [Project]
}

struct ContextHandoffResult: Decodable {
  let terminalSessionId, panelId, projectId, targetAgent, mode, status: String
  let handoffFilePath: String?
}
