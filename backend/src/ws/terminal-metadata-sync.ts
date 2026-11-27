import type { WebSocket } from "ws";
import { logger } from "../logging/index";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager/manager";
import { isTmuxBackedSession, resolveTmuxTarget } from "../terminal/runtime/launcher";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import type { TmuxService } from "../terminal/tmux/service";
import {
  getTmuxPaneMetadataReader,
  sendEvent,
  TMUX_METADATA_SYNC_DELAY_MS,
} from "./terminal-server-connection-helpers";
import { shouldKeepExistingActiveCommand } from "./terminal-metadata-policy";

const terminalWsLogger = logger.child({ component: "terminal-ws" });
const TMUX_ACTIVE_COMMAND_RESYNC_DELAY_MS = 1_000;
const socketScrollControllers = new WeakMap<
  WebSocket,
  { sync: () => Promise<void> }
>();

export function registerTerminalScrollController(
  socket: WebSocket,
  controller: { sync: () => Promise<void> } | undefined,
): void {
  if (controller) {
    socketScrollControllers.set(socket, controller);
  }
}

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
  let tmuxMetadataSyncFireAt = 0;
  let tmuxMetadataSyncInFlight = false;
  let tmuxMetadataSyncPendingAfterFlight = false;
  let shellPromptCommandActive = false;
  let lastSentMetadata: {
    cwd: string;
    activeCommand: string | null;
  } | null = null;
  let lastScrollSyncSnapshot: {
    activeCommand: string | null;
    paneId: string;
    applicationMode: string;
    owner: string;
    copyMode: boolean;
  } | null = null;

  const syncScrollStateIfChanged = async (
    activeCommandHint?: string | null,
  ): Promise<void> => {
    if (
      !session ||
      !tmuxService ||
      !isTmuxBackedSession(session) ||
      typeof tmuxService.readScrollState !== "function"
    ) {
      return;
    }
    const scrollController = socketScrollControllers.get(socket);
    if (!scrollController) {
      return;
    }
    try {
      const base = resolveTmuxTarget(session, tmuxService);
      const selectedPaneId =
        typeof tmuxService.readSelectedPane === "function"
          ? await tmuxService.readSelectedPane(base)
          : null;
      const workspace =
        terminalSessionManager.getPanelWorkspace(terminalSessionId);
      const activePanel = workspace
        ? terminalSessionManager.getPanel(workspace.activePanelId)
        : undefined;
      if (selectedPaneId && activePanel?.tmuxPaneId !== selectedPaneId) {
        const matchedPanel = terminalSessionManager
          .listPanels(terminalSessionId)
          .find((candidate) => candidate.tmuxPaneId === selectedPaneId);
        if (matchedPanel) {
          await terminalSessionManager.focusPanel(
            terminalSessionId,
            matchedPanel.id,
          );
        }
      }
      const paneId = selectedPaneId ?? activePanel?.tmuxPaneId ?? null;
      if (!paneId) {
        return;
      }
      const scrollState = await tmuxService.readScrollState({
        ...base,
        paneId,
      });
      const currentActiveCommand =
        activeCommandHint !== undefined
          ? activeCommandHint
          : (terminalSessionManager.getSession(terminalSessionId)
              ?.activeCommand ??
            lastSentMetadata?.activeCommand ??
            null);
      const changed =
        !lastScrollSyncSnapshot ||
        lastScrollSyncSnapshot.activeCommand !== currentActiveCommand ||
        lastScrollSyncSnapshot.paneId !== paneId ||
        lastScrollSyncSnapshot.applicationMode !==
          scrollState.applicationMode ||
        lastScrollSyncSnapshot.owner !== scrollState.owner ||
        lastScrollSyncSnapshot.copyMode !== scrollState.copyMode;
      lastScrollSyncSnapshot = {
        activeCommand: currentActiveCommand,
        paneId,
        applicationMode: scrollState.applicationMode,
        owner: scrollState.owner,
        copyMode: scrollState.copyMode,
      };
      if (changed) {
        await scrollController.sync();
      }
    } catch {
      // Scroll target lifecycle is owned by the terminal runtime connection.
    }
  };

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
    await syncScrollStateIfChanged(metadata.activeCommand);
  };

  const scheduleTmuxPaneMetadataSync = (
    delayMs = TMUX_METADATA_SYNC_DELAY_MS,
  ): void => {
    if (
      !session ||
      !isTmuxBackedSession(session) ||
      (!tmuxPaneMetadataReader &&
        typeof tmuxService?.readScrollState !== "function")
    ) {
      return;
    }
    if (tmuxMetadataSyncInFlight) {
      if (delayMs <= TMUX_METADATA_SYNC_DELAY_MS) {
        tmuxMetadataSyncPendingAfterFlight = true;
      }
      return;
    }
    const requestedFireAt = Date.now() + delayMs;
    if (tmuxMetadataSyncTimer) {
      if (tmuxMetadataSyncFireAt <= requestedFireAt) {
        return;
      }
      clearTimeout(tmuxMetadataSyncTimer);
    }
    tmuxMetadataSyncFireAt = requestedFireAt;
    tmuxMetadataSyncTimer = setTimeout(() => {
      tmuxMetadataSyncTimer = null;
      tmuxMetadataSyncFireAt = 0;
      void syncTmuxPaneMetadata();
    }, delayMs);
  };

  const syncTmuxPaneMetadata = async (): Promise<void> => {
    if (
      !session ||
      !tmuxService ||
      !isTmuxBackedSession(session) ||
      tmuxMetadataSyncInFlight
    ) {
      return;
    }

    tmuxMetadataSyncInFlight = true;
    tmuxMetadataSyncPendingAfterFlight = false;
    try {
      let resolvedActiveCommand: string | null | undefined;
      if (!shellPromptCommandActive && tmuxPaneMetadataReader) {
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
          resolvedActiveCommand = publishableMetadata.activeCommand;
          await publishMetadata(publishableMetadata);
        }
      }
      await syncScrollStateIfChanged(resolvedActiveCommand);
      const activeCommand =
        resolvedActiveCommand ??
        terminalSessionManager.getSession(terminalSessionId)?.activeCommand ??
        null;
      if (tmuxMetadataSyncPendingAfterFlight) {
        tmuxMetadataSyncPendingAfterFlight = false;
        tmuxMetadataSyncInFlight = false;
        scheduleTmuxPaneMetadataSync(TMUX_METADATA_SYNC_DELAY_MS);
        return;
      }
      if (activeCommand !== null || shellPromptCommandActive) {
        tmuxMetadataSyncInFlight = false;
        scheduleTmuxPaneMetadataSync(TMUX_ACTIVE_COMMAND_RESYNC_DELAY_MS);
        return;
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
        tmuxMetadataSyncFireAt = 0;
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
