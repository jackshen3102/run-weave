import Foundation

// Source: packages/shared/src/attention.ts
struct AttentionSnapshot: Codable, Equatable {
  let generatedAt: String
  let slots: [AttentionSlot]
}

struct AttentionSlot: Codable, Identifiable, Equatable {
  struct Source: Codable, Equatable {
    let kind: String
    let evidence: String
  }

  let attentionId: String
  let projectId: String
  let terminalSessionId: String
  let panelId: String?
  let panelLabel: String?
  let state: String
  let actionKind: String?
  let title: String
  let detail: String
  let updatedAt: String
  let source: Source
  let completionRevision: Int?
  var id: String { attentionId }

  var actionLabel: String? {
    guard state == "needs_action" else { return nil }
    switch actionKind {
    case "question": return "需回答"
    case "permission": return "需授权"
    case "auth": return "需认证"
    case "pr_attention": return "PR 待处理"
    default: return "待处理"
    }
  }
}

struct AttentionPanelFocusResponse: Decodable {
  let activePanelId: String
}
