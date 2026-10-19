import { useSideChat } from "../../../features/side-chat/use-side-chat";
import { useMemoizedFn } from "ahooks";
import { useOverlayRef } from "../../../features/overlay/use-overlay-ref";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { GitFork, Link2, MessageCircle, PanelsTopLeft, Pencil, X } from "lucide-react";
import { useForkTerminalAgent } from "../../../features/terminal/use-fork-agent";
import { formatTerminalSessionName } from "../../../features/terminal/state/session-name";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { Button } from "../../ui/button";
import { ShimmerText } from "../../ui/shimmer-text";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";

function getTerminalStateLabel(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Exited";
  }
  if (!terminalState) {
    return "Status unavailable";
  }
  if (terminalState.state === "agent_running") {
    return "Agent running";
  }
  if (terminalState.state === "agent_starting") {
    return "Agent starting";
  }
  if (terminalState.state === "agent_idle") {
    return "Agent idle";
  }
  return "Shell idle";
}

function getTerminalStateDetail(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Terminal exited";
  }
  if (!terminalState) {
    return "Waiting for state";
  }
  if (terminalState.state === "agent_running") {
    return "Model response in progress";
  }
  if (terminalState.state === "agent_starting") {
    return "Starting agent";
  }
  if (terminalState.state === "agent_idle") {
    return "Waiting for input";
  }
  return "Shell ready";
}

function formatCommandForDisplay(session: TerminalSessionListItem): string {
  const command = session.activeCommand?.trim() || session.command.trim();
  if (!command) {
    return "-";
  }
  const args = session.activeCommand?.trim() ? [] : session.args;
  return [command, ...args].join(" ");
}

function formatActivityTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "Just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function TerminalTabStateDot({
  session,
  terminalState,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
}) {
  if (session.status === "exited") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-slate-600 bg-slate-800"
      />
    );
  }
  if (!terminalState) {
    return null;
  }
  if (terminalState.state === "agent_running") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-cyan-200 bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.75)] motion-safe:animate-pulse"
      />
    );
  }
  if (terminalState.state === "agent_starting") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-amber-200 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)] motion-safe:animate-pulse"
      />
    );
  }
  if (terminalState.state === "agent_idle") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full border border-slate-500 bg-transparent"
    />
  );
}

function TerminalTabStateCard({
  session,
  terminalState,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
}) {
  const stateLabel = getTerminalStateLabel(session, terminalState);
  const detail = getTerminalStateDetail(session, terminalState);
  return (
    <div className="space-y-2 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        <TerminalTabStateDot session={session} terminalState={terminalState} />
        <div className="min-w-0">
          <div className="font-medium text-slate-100">{stateLabel}</div>
          <div className="truncate text-slate-400">{detail}</div>
        </div>
      </div>
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span className="text-slate-500">Agent</span>
        <span className="truncate text-slate-200">
          {terminalState?.agent ?? "-"}
        </span>
        <span className="text-slate-500">Command</span>
        <span className="truncate text-slate-200">
          {formatCommandForDisplay(session)}
        </span>
        <span className="text-slate-500">Activity</span>
        <span className="truncate text-slate-200">
          {formatActivityTime(session.lastActivityAt)}
        </span>
      </div>
    </div>
  );
}

export function TerminalSessionTab({
  session,
  hasContextLink = false,
  isDragging,
  isMobileMonitor,
  panelCount,
  onSelectSession,
  onRequestCloseSession,
  onRequestEditAlias,
  onPanelSplitEnabledChange,
}: {
  session: TerminalSessionListItem;
  hasContextLink?: boolean;
  isDragging: boolean;
  isMobileMonitor: boolean;
  panelCount: number;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onRequestEditAlias: (session: TerminalSessionListItem) => void;
  onPanelSplitEnabledChange: (enabled: boolean) => void;
}) {
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const { fork, pending: forking } = useForkTerminalAgent(session.terminalSessionId);
  const mutationLoading = useTerminalWorkspaceStore((state) => state.loading);
  const activePanel = useTerminalWorkspaceStore((state) => {
    const workspace = state.panelWorkspaceBySessionId[session.terminalSessionId];
    return workspace?.panels.find((panel) => panel.panelId === workspace.activePanelId);
  });
  const hasBellMarker = useTerminalWorkspaceStore(
    (state) => state.bellMarkers[session.terminalSessionId],
  );
  const hasCompletion = useTerminalWorkspaceStore(
    (state) => state.completionMarkers[session.terminalSessionId],
  );
  const terminalState = useTerminalWorkspaceStore(
    (state) => state.terminalStateBySessionId[session.terminalSessionId],
  );
  const forkState = panelCount <= 1
    ? terminalState ?? activePanel?.terminalState ?? session.terminalState
    : activePanel?.terminalState;
  const canFork = session.status === "running" && Boolean(session.tmuxSessionName) &&
    forkState?.agent === "codex" && forkState.state === "agent_idle";
  const isActive = session.terminalSessionId === activeSessionId;
  const hasBell = !isActive && Boolean(hasBellMarker);
  const panelSplitEnabled = session.panelSplitEnabled;
  const tabRef = useRef<HTMLDivElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const sideChatPanelId = useTerminalWorkspaceStore((state) =>
    state.activePanelIdBySessionId[session.terminalSessionId]
    ?? state.panelWorkspaceBySessionId[session.terminalSessionId]?.activePanelId
    ?? session.activePanelId ?? null,
  );
  const sideChat = useSideChat(session.terminalSessionId, sideChatPanelId);
  const openSideChat = useMemoizedFn(async () => {
    onSelectSession(session.terminalSessionId);
    await sideChat.model.open();
    if (!sideChat.model.navigation.visible && sideChat.model.state.error) {
      useTerminalWorkspaceStore.getState().setRequestError(sideChat.model.state.error);
    }
  });
  const originalDisplayName = formatTerminalSessionName({
    alias: session.alias,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
  });
  const displayName = sideChat.visible ? `旁聊 · ${originalDisplayName}` : originalDisplayName;
  const [confirmClose, setConfirmClose] = useState(false);
  const isWorking = terminalState?.state === "agent_running";
  const disablePanelSplitToggle = panelSplitEnabled && panelCount > 1;
  const showStateDetails =
    !isMobileMonitor && (Boolean(terminalState) || session.status === "exited");
  const openDetails = (): void => {
    if (showStateDetails) {
      const rect = tabRef.current?.getBoundingClientRect();
      if (rect) {
        setDetailsPosition({
          left: Math.min(rect.left, window.innerWidth - 272),
          top: rect.bottom + 4,
        });
      }
      setDetailsOpen(true);
    }
  };
  const closeDetailsOnBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setDetailsOpen(false);
  };

  const tab = (
    <div
      ref={tabRef}
      onMouseEnter={openDetails}
      onPointerEnter={openDetails}
      onMouseLeave={() => {
        setDetailsOpen(false);
      }}
      onPointerLeave={() => {
        setDetailsOpen(false);
      }}
      onFocusCapture={openDetails}
      onBlurCapture={closeDetailsOnBlur}
      className={[
        "relative flex h-full shrink-0 items-center gap-2 border-r border-slate-800 pl-2 pr-3",
        isDragging
          ? "bg-sky-500/20 text-slate-50 opacity-90"
          : isActive
            ? "overflow-hidden bg-slate-900/35 text-slate-50 before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:bg-sky-500"
            : "text-slate-300 hover:bg-slate-900/45 hover:text-slate-100",
      ].join(" ")}
    >
      <button
        type="button"
        aria-label={displayName}
        data-terminal-session-id={session.terminalSessionId}
        className={[
          "inline-flex h-full min-w-0 max-w-[220px] items-center gap-1.5 py-0 text-xs",
          isActive ? "text-slate-50" : "text-slate-200",
        ].join(" ")}
        onMouseEnter={openDetails}
        onPointerEnter={openDetails}
        onFocus={openDetails}
        onClick={() => {
          onSelectSession(session.terminalSessionId);
        }}
      >
        {isWorking ? (
          <ShimmerText
            className="truncate shimmer-invert"
            style={
              {
                "--shimmer-duration": "4000",
                "--shimmer-repeat-delay": "300",
              } as CSSProperties
            }
          >
            {displayName}
          </ShimmerText>
        ) : (
          <span className="truncate">{displayName}</span>
        )}
        <span
          aria-hidden="true"
          className={[
            "h-1.5 w-1.5 shrink-0 rounded-full",
            hasBell
              ? "bg-amber-400"
              : hasCompletion
                ? "bg-emerald-400"
                : "bg-transparent",
          ].join(" ")}
        />
        {hasContextLink ? <Link2 aria-label="已关联随记" className="size-3 shrink-0 text-slate-500" /> : null}
        {sideChat.state.unread ? <span aria-label="旁聊有新回复" className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      </button>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}><DialogContent><DialogHeader><DialogTitle>关闭终端和旁聊？</DialogTitle><DialogDescription>关闭整个终端会同时结束关联的活跃旁聊。旁聊记录保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setConfirmClose(false)}>取消</Button><Button variant="destructive" onClick={() => { setConfirmClose(false); onRequestCloseSession(session.terminalSessionId); }}>关闭终端</Button></DialogFooter></DialogContent></Dialog>
      {!isMobileMonitor ? (
        <button
          type="button"
          className={[
            "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
            isActive
              ? "text-slate-400 hover:text-slate-100"
              : "text-slate-500 hover:text-slate-200",
          ].join(" ")}
          aria-label={`Close terminal ${displayName}`}
          onClick={async () => {
            await sideChat.model.discover();
            if ((sideChat.model.navigation.chatId && sideChat.state.snapshot?.sideChat.status !== "ended") || sideChat.model.state.capabilities?.activeSideChatId) setConfirmClose(true);
            else onRequestCloseSession(session.terminalSessionId);
          }}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );

  const detailsOverlayRef = useOverlayRef<HTMLDivElement>();
  const detailsCard =
    showStateDetails && detailsOpen && detailsPosition
      ? createPortal(
          <div
            ref={detailsOverlayRef}
            className="pointer-events-none z-50 w-64 rounded-md border border-slate-700 bg-slate-950/95 p-3 text-slate-100 shadow-xl"
            style={{
              position: "fixed",
              left: detailsPosition.left,
              top: detailsPosition.top,
            }}
          >
            <TerminalTabStateCard
              session={session}
              terminalState={terminalState}
            />
          </div>,
          document.body,
        )
      : null;

  if (isMobileMonitor) {
    return tab;
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem className="gap-2" disabled={sideChat.state.loading}
            title={sideChat.state.capabilities?.reason ?? "独立消息旁聊"}
            onSelect={() => { void openSideChat(); }}>
            <MessageCircle className="size-4" />
            旁聊{sideChat.state.unread ? " · 新回复" : ""}
          </ContextMenuItem>
          <ContextMenuItem className="gap-2" disabled={!canFork || forking || mutationLoading}
            title={canFork ? undefined : "请等待当前 Codex 会话空闲后再 Fork"}
            onSelect={() => { void fork(); }}>
            <GitFork className="h-4 w-4" />
            {forking ? "正在 Fork Codex…" : "Fork Thread"}
          </ContextMenuItem>
          <ContextMenuItem
            className="gap-2"
            onSelect={() => {
              onRequestEditAlias(session);
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename Alias
          </ContextMenuItem>
          <ContextMenuItem
            aria-disabled={disablePanelSplitToggle ? true : undefined}
            className={[
              "gap-2",
              disablePanelSplitToggle
                ? "text-muted-foreground opacity-50 focus:bg-transparent focus:text-muted-foreground"
                : "",
            ].join(" ")}
            title={
              disablePanelSplitToggle
                ? "Close extra panels before disabling panel split."
                : undefined
            }
            onSelect={(event) => {
              if (disablePanelSplitToggle) {
                event.preventDefault();
                return;
              }
              onPanelSplitEnabledChange(!panelSplitEnabled);
            }}
          >
            <PanelsTopLeft className="h-4 w-4" />
            {panelSplitEnabled ? "Disable Panel Split" : "Enable Panel Split"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {detailsCard}
    </>
  );
}

export function TerminalSessionAliasDialog({
  open,
  loading,
  session,
  onClose,
  onSubmit,
}: {
  open: boolean;
  loading: boolean;
  session: TerminalSessionListItem | null;
  onClose: () => void;
  onSubmit: (alias: string) => Promise<void>;
}) {
  const [alias, setAlias] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    setAlias(session?.alias ?? "");
  }, [open, session?.alias]);

  if (!open || !session) {
    return null;
  }

  const fallbackName = formatTerminalSessionName({
    cwd: session.cwd,
    activeCommand: session.activeCommand,
  });
  const submit = async (): Promise<void> => {
    await onSubmit(alias);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename Terminal</DialogTitle>
          <DialogDescription className="truncate">
            {fallbackName}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="terminal-alias">Alias</Label>
          <Input
            id="terminal-alias"
            value={alias}
            maxLength={80}
            autoFocus
            placeholder="coder"
            onChange={(event) => setAlias(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to use the default terminal name.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={loading}
            onClick={() => {
              void submit();
            }}
          >
            {loading ? "Saving..." : "Save Alias"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
