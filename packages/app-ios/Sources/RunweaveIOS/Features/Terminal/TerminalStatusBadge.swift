import SwiftUI

struct TerminalStatusBadge: View {
  let terminal: HomeTerminal

  private var state: String {
    terminal.status == "exited" ? "exited" : terminal.terminalState.state
  }
  private var busy: Bool { terminal.isAgentActive }
  private var label: String {
    switch state {
    case "agent_running": return "正在执行"
    case "agent_starting": return "启动中"
    case "agent_idle": return "等待输入"
    case "shell_idle": return "终端空闲"
    case "exited": return "已退出"
    default: return "状态未知"
    }
  }
  private var color: Color {
    switch state {
    case "agent_running": return .cyan
    case "agent_starting": return .orange
    case "agent_idle": return .blue
    default: return .secondary
    }
  }

  var body: some View {
    HStack(spacing: 4) {
      if busy {
        ProgressView().tint(color).scaleEffect(0.65).frame(width: 12, height: 12)
      } else if state == "shell_idle" {
        Circle().stroke(color, lineWidth: 1).frame(width: 6, height: 6)
      } else {
        Circle().fill(color).frame(width: 6, height: 6)
      }
      Text(label)
    }
    .font(.caption).foregroundColor(color)
    .accessibilityElement(children: .ignore).accessibilityLabel(label)
  }
}

struct TerminalAttentionBadge: View {
  let unread: Bool
  let bell: Bool
  var showLabel = true

  private var label: String {
    bell ? (unread ? "响铃 · 待接管" : "终端响铃") : "待接管"
  }

  var body: some View {
    if unread || bell {
      HStack(spacing: 4) {
        Circle().fill(bell ? Color.orange : Color.green).frame(width: 7, height: 7)
        if showLabel { Text(label).font(.caption) }
      }
      .foregroundColor(bell ? Color.orange : Color.green)
      .accessibilityElement(children: .ignore).accessibilityLabel(label)
    }
  }
}

struct TerminalGroupStatus: View {
  let terminals: [HomeTerminal]
  let bells: Set<String>
  private var unreadCount: Int { terminals.filter(\.hasUnreadCompletion).count }
  private var working: Bool {
    terminals.contains { $0.status != "exited" && $0.terminalState.state == "agent_running" }
  }
  private var hasBell: Bool { terminals.contains { bells.contains($0.id) } }

  var body: some View {
    HStack(spacing: 5) {
      if working {
        ProgressView().tint(.cyan).scaleEffect(0.65).frame(width: 12, height: 12)
          .accessibilityLabel("项目中有任务正在执行")
      }
      TerminalAttentionBadge(unread: unreadCount > 0, bell: hasBell, showLabel: false)
      if unreadCount > 0 {
        Text("\(unreadCount) 待接管").font(.caption2).foregroundColor(.green)
      }
    }
  }
}
