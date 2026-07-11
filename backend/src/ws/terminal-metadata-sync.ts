import type { WebSocket } from "ws";
import { logger } from "../logging";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import { isTmuxBackedSession, resolveTmuxTarget } from "../terminal/runtime-launcher";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import type { TmuxService } from "../terminal/tmux-service";
import {
  getTmuxPaneMetadataReader,
  sendEvent,
  TMUX_METADATA_SYNC_DELAY_MS,
} from "./terminal-server-connection-helpers";
import { shouldKeepExistingActiveCommand } from "./terminal-metadata-policy";

const terminalWsLogger = logger.child({ component: "terminal-ws" });
const TMUX_ACTIVE_COMMAND_RESYNC_DELAY_MS = 1_000;

interface TerminalMetadataSyncControllerOptions {
  session: TerminalSessionRecord | undefined;
  socket: WebSocket;
  terminalSessionId: string;
  terminalSessionManager: TerminalSessionManager;
  terminalStateService?: TerminalStateService;
  tmuxService?: TmuxService;
}

export interface TerminalMetadataSyncController {
  clearTmuxPaneMetadataSync: () => void;
  publishMetadata: (
    metadata: {
      cwd: string;
      activeCommand: string | null;
    },
    publishOptions?: { forceSend?: boolean },
  ) => Promise<void>;
  scheduleTmuxPaneMetadataSync: (delayMs?: number) => void;
  setShellPromptCommandActive: (active: boolean) => void;
  syncTmuxPaneMetadata: () => Promise<void>;
}

export function createTerminalMetadataSyncController({
  session,
  socket,
  terminalSessionId,
  terminalSessionManager,
  terminalStateService,
  tmuxService,
}: TerminalMetadataSyncControllerOptions): TerminalMetadataSyncController {
  const tmuxPaneMetadataReader = getTmuxPaneMetadataReader(tmuxService);
  let tmuxMetadataSyncTimer: NodeJS.Timeout | null = null;
  let tmuxMetadataSyncInFlight = false;
  let shellPromptCommandActive = false;
  let lastSentMetadata: {
    cwd: string;
    activeCommand: string | null;
  } | null = null;

  const publishMetadata = async (
    metadata: {
      cwd: string;
      activeCommand: string | null;
    },
    publishOptions?: { forceSend?: boolean },
  ): Promise<void> => {
    const current = terminalSessionManager.getSession(terminalSessionId);
    const metadataChanged =
      current?.cwd !== metadata.cwd ||
      current.activeCommand !== metadata.activeCommand;
    const clientMetadataChanged =
      !lastSentMetadata ||
      lastSentMetadata.cwd !== metadata.cwd ||
      lastSentMetadata.activeCommand !== metadata.activeCommand;
    if (
      !metadataChanged &&
      !clientMetadataChanged &&
      !publishOptions?.forceSend
    ) {
      return;
    }

    if (metadataChanged) {
      const updatedSession = await terminalSessionManager.updateSessionMetadata(
        terminalSessionId,
        {
          cwd: metadata.cwd,
          activeCommand: metadata.activeCommand,
        },
      );
      if (updatedSession) {
        terminalStateService?.setShellActiveCommand(
          terminalSessionId,
          updatedSession,
          {
            projectId: updatedSession.projectId,
            reason: updatedSession.status === "exited" ? "exit" : "metadata",
          },
        );
      }
    }
    sendEvent(socket, {
      type: "metadata",
      cwd: metadata.cwd,
      activeCommand: metadata.activeCommand,
    });
    lastSentMetadata = {
      cwd: metadata.cwd,
      activeCommand: metadata.activeCommand,
    };
  };

  const scheduleTmuxPaneMetadataSync = (
    delayMs = TMUX_METADATA_SYNC_DELAY_MS,
  ): void => {
    if (!session || !isTmuxBackedSession(session) || !tmuxPaneMetadataReader) {
      return;
    }
    if (tmuxMetadataSyncTimer) {
      clearTimeout(tmuxMetadataSyncTimer);
    }
    tmuxMetadataSyncTimer = setTimeout(() => {
      tmuxMetadataSyncTimer = null;
      void syncTmuxPaneMetadata();
    }, delayMs);
  };

  const syncTmuxPaneMetadata = async (): Promise<void> => {
    if (
      !session ||
      !tmuxService ||
      !tmuxPaneMetadataReader ||
      !isTmuxBackedSession(session) ||
      shellPromptCommandActive ||
      tmuxMetadataSyncInFlight
    ) {
      return;
    }

    tmuxMetadataSyncInFlight = true;
    try {
      const metadata = await tmuxPaneMetadataReader(
        resolveTmuxTarget(session, tmuxService),
        session.command,
      );
      if (metadata) {
        const currentSession =
          terminalSessionManager.getSession(terminalSessionId);
        const publishableMetadata = shouldKeepExistingActiveCommand(
          currentSession?.activeCommand ?? null,
          metadata.activeCommand,
          metadata.activeCommandSource,
        )
          ? {
              ...metadata,
              activeCommand: currentSession?.activeCommand ?? null,
            }
          : metadata;
        await publishMetadata(publishableMetadata);
        if (publishableMetadata.activeCommand !== null) {
          scheduleTmuxPaneMetadataSync(TMUX_ACTIVE_COMMAND_RESYNC_DELAY_MS);
        }
      }
    } catch (error) {
      terminalWsLogger.error("terminal.tmux.metadata-sync.failed", {
        message: "Tmux pane metadata sync failed",
        terminalSessionId,
        error,
      });
    } finally {
      tmuxMetadataSyncInFlight = false;
    }
  };

  return {
    clearTmuxPaneMetadataSync: () => {
      if (tmuxMetadataSyncTimer) {
        clearTimeout(tmuxMetadataSyncTimer);
        tmuxMetadataSyncTimer = null;
      }
    },
    publishMetadata,
    scheduleTmuxPaneMetadataSync,
    setShellPromptCommandActive: (active) => {
      shellPromptCommandActive = active;
    },
    syncTmuxPaneMetadata,
  };
}
