import Foundation

// Wire contract in packages/shared/src/terminal/context-handoff.ts
struct ContextHandoffPreview: Decodable {
  struct Project: Decodable { let projectId, name: String }
  struct PlanFile: Decodable, Identifiable {
    let relativePath, absolutePath, source: String
    let sizeBytes: Int
    var id: String { relativePath }
  }
  let sourceTerminalId, sourcePanelId, sourceProvider, sourceThreadId, sourceRevision, sourceProjectId: String
  let totalMessages, includedMessages, omittedMessages, includedTurns, partialTurns, omittedTurns, handoffBytes, budgetBytes: Int
  let canNativeCodexFork: Bool
  let targetProjects: [Project]
  let canInPlaceHandoff: Bool?
  let inPlaceUnavailableReason: String?
  let detectedPlanFiles: [PlanFile]?
}

struct ContextHandoffResult: Decodable {
  let terminalSessionId, panelId, projectId, targetAgent, mode, status: String
  let placement: String?
  let handoffFilePath: String?
}
