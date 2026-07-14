import type { TerminalCompletionEventPayload } from "./completion";
import type { TerminalPanelListItem, TerminalPanelWorkspace } from "./panel";
import type { TerminalProjectListItem } from "./project";
import type { TerminalSessionListItem } from "./session";
import type {
  TerminalAgentKind,
  TerminalState,
  TerminalStateChangeReason,
} from "./state";

export interface TerminalStateChangedEventPayload {
  previous: TerminalState;
  next: TerminalState;
  reason: TerminalStateChangeReason;
}

export interface TerminalBellEventPayload {
  count: number;
}

export interface TerminalSessionMetadataSnapshot {
  cwd: string;
  activeCommand: string | null;
}

export interface TerminalSessionMetadataChangedEventPayload {
  previous: TerminalSessionMetadataSnapshot;
  next: TerminalSessionMetadataSnapshot;
}

export interface TerminalNotificationEventPayload {
  level: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  source: "codex" | "terminal" | "system";
  dedupeKey?: string;
  action?: {
    type: "open_terminal";
    terminalSessionId: string;
  };
}

export interface TerminalProjectCreatedEventPayload {
  project: TerminalProjectListItem;
}

export interface TerminalSessionCreatedEventPayload {
  session: TerminalSessionListItem;
}

export interface TerminalProjectDeletedEventPayload {
  projectId: string;
  terminalSessionIds: string[];
}

export interface TerminalSessionDeletedEventPayload {
  terminalSessionId: string;
  projectId: string | null;
}

export interface TerminalPanelCreatedEventPayload {
  panel: TerminalPanelListItem;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelUpdatedEventPayload {
  panel: TerminalPanelListItem;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelDeletedEventPayload {
  terminalSessionId: string;
  panelId: string;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelFocusedEventPayload {
  terminalSessionId: string;
  panelId: string;
  alias: string | null;
  role?: string | null;
  source: "ui" | "cli" | "api" | "tmux";
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelInputSentEventPayload {
  terminalSessionId: string;
  panelId: string;
  alias: string | null;
  role?: string | null;
  operationId: string;
  workspace: TerminalPanelWorkspace;
}

export type TerminalEventKind =
  | "completion"
  | "project_created"
  | "project_deleted"
  | "terminal_session_created"
  | "terminal_session_deleted"
  | "terminal_state_changed"
  | "terminal_bell"
  | "terminal_session_metadata_changed"
  | "terminal_notification"
  | "terminal_panel_created"
  | "terminal_panel_updated"
  | "terminal_panel_deleted"
  | "terminal_panel_focused"
  | "terminal_panel_input_sent";

interface TerminalEventEnvelopeBase {
  id: string;
  terminalSessionId: string | null;
  projectId: string | null;
  createdAt: string;
}

export type TerminalEventEnvelope =
  | (TerminalEventEnvelopeBase & {
      kind: "completion";
      terminalSessionId: string;
      payload: TerminalCompletionEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_state_changed";
      terminalSessionId: string;
      payload: TerminalStateChangedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_bell";
      terminalSessionId: string;
      projectId: string;
      payload: TerminalBellEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_session_metadata_changed";
      terminalSessionId: string;
      projectId: string;
      payload: TerminalSessionMetadataChangedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_notification";
      terminalSessionId: string;
      payload: TerminalNotificationEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "project_created";
      terminalSessionId: null;
      projectId: string;
      payload: TerminalProjectCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "project_deleted";
      terminalSessionId: null;
      projectId: string;
      payload: TerminalProjectDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_session_created";
      terminalSessionId: string;
      projectId: string;
      payload: TerminalSessionCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_session_deleted";
      terminalSessionId: string;
      projectId: string | null;
      payload: TerminalSessionDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_created";
      terminalSessionId: string;
      payload: TerminalPanelCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_updated";
      terminalSessionId: string;
      payload: TerminalPanelUpdatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_deleted";
      terminalSessionId: string;
      payload: TerminalPanelDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_focused";
      terminalSessionId: string;
      payload: TerminalPanelFocusedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_input_sent";
      terminalSessionId: string;
      payload: TerminalPanelInputSentEventPayload;
    });

export interface TerminalCompletionEventListResponse {
  events: TerminalEventEnvelope[];
}

export interface TerminalStateResponse {
  terminalState: TerminalState;
}

export type AgentHookStateEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "ToolRequested"
  | "ToolCompleted";

export interface AgentHookStateRequest {
  activityEventId?: string;
  operationId?: string;
  terminalSessionId: string;
  projectId?: string;
  threadId?: string;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  commandName?: string | null;
  rawHookEvent?: string;
  sessionSource?: "startup" | "resume";
  query?: string;
  response?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  agent: TerminalAgentKind;
  hookEvent: AgentHookStateEvent;
}

export interface TerminalEventCursorGap {
  reason: "cursor-too-old" | "cursor-ahead";
  requestedAfter: string;
  oldestAvailableEventId: string | null;
  latestEventId: string | null;
}

export type TerminalEventServerMessage =
  | {
      type: "connected";
      acceptedAfter: string | null;
      streamId: string;
      gap: TerminalEventCursorGap | null;
    }
  | {
      type: "terminal-events";
      delivery: "catchup";
      events: TerminalEventEnvelope[];
    }
  | {
      type: "terminal-event";
      delivery: "live";
      event: TerminalEventEnvelope;
    }
  | {
      type: "error";
      message: string;
    };
