import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Home, Moon, RefreshCw, Sun, Terminal } from "lucide-react";
import { useTheme } from "next-themes";
import type {
  TerminalMobileOverviewSession,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import { HttpError } from "../../../services/http";
import { getTerminalMobileOverview } from "../../../services/terminal";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { TerminalCard } from "./TerminalCard";
import { TerminalDetailDrawer } from "./TerminalDetailDrawer";
import {
  buildMobileTerminalCards,
  buildProjectSummaries,
  sortMobileTerminalCards,
  type MobileTerminalCardViewModel,
} from "./terminal-card-view-model";
import {
  matchesMobileTerminalFilter,
  TerminalStatusFilter,
  type MobileTerminalFilter,
} from "./TerminalStatusFilter";
import { buildHermesContext } from "./HermesHandoffPreview";

interface MobileTerminalPageProps {
  apiBase: string;
  token: string;
  onAuthExpired?: () => void;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back below. Mobile browsers can expose this API but reject on permissions.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("复制失败，请长按预览内容手动复制。");
  }
}

function MobileThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && (resolvedTheme ?? theme) === "dark";

  return (
    <button
      type="button"
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
      onClick={() => {
        setTheme(isDark ? "light" : "dark");
      }}
      title={isDark ? "切换浅色模式" : "切换暗色模式"}
      aria-label={isDark ? "切换浅色模式" : "切换暗色模式"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function MobileTerminalPage({
  apiBase,
  token,
  onAuthExpired,
}: MobileTerminalPageProps) {
  const [projects, setProjects] = useState<TerminalProjectListItem[]>([]);
  const [sessions, setSessions] = useState<TerminalMobileOverviewSession[]>([]);
  const [changedSessionIds, setChangedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const previousScrollbackRef = useRef<Record<string, string>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [filter, setFilter] = useState<MobileTerminalFilter>("all");
  const [selectedTerminal, setSelectedTerminal] =
    useState<MobileTerminalCardViewModel | null>(null);
  const [drawerMode, setDrawerMode] = useState<"detail" | "handoff">("detail");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const overview = await getTerminalMobileOverview(apiBase, token);
      const nextChangedSessionIds = new Set<string>();

      for (const session of overview.sessions) {
        const nextTail = session.tailScrollback;
        const previousTail =
          previousScrollbackRef.current[session.terminalSessionId];
        if (previousTail !== undefined && previousTail !== nextTail) {
          nextChangedSessionIds.add(session.terminalSessionId);
        }
        previousScrollbackRef.current[session.terminalSessionId] = nextTail;
      }

      setProjects(overview.projects);
      setSessions(overview.sessions);
      setChangedSessionIds(nextChangedSessionIds);
      setSelectedProjectId((currentProjectId) => {
        if (
          currentProjectId &&
          overview.projects.some(
            (project) => project.projectId === currentProjectId,
          )
        ) {
          return currentProjectId;
        }
        return overview.projects[0]?.projectId ?? null;
      });
    } catch (loadError) {
      if (loadError instanceof HttpError && loadError.status === 401) {
        onAuthExpired?.();
        return;
      }

      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, [apiBase, onAuthExpired, token]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const cards = useMemo(
    () =>
      buildMobileTerminalCards({
        projects,
        sessions,
        changedSessionIds,
      }),
    [changedSessionIds, projects, sessions],
  );

  const summaries = useMemo(
    () => buildProjectSummaries({ projects, cards }),
    [cards, projects],
  );
  const selectedSummary =
    summaries.find((project) => project.projectId === selectedProjectId) ??
    summaries[0] ??
    null;
  const visibleCards = useMemo(() => {
    return sortMobileTerminalCards(
      cards.filter((card) => {
        if (selectedProjectId && card.projectId !== selectedProjectId) {
          return false;
        }
        if (!matchesMobileTerminalFilter(card.inferredWorkloadState, filter)) {
          return false;
        }
        return true;
      }),
    );
  }, [cards, filter, selectedProjectId]);

  const openDetail = (terminal: MobileTerminalCardViewModel): void => {
    setCopied(false);
    setCopyError(null);
    setDrawerMode("detail");
    setSelectedTerminal(terminal);
  };

  const openHandoff = (terminal: MobileTerminalCardViewModel): void => {
    setCopied(false);
    setCopyError(null);
    setDrawerMode("handoff");
    setSelectedTerminal(terminal);
  };

  const copyTerminalContext = async (
    terminal: MobileTerminalCardViewModel,
  ): Promise<void> => {
    setCopyError(null);
    try {
      await copyText(buildHermesContext(terminal));
    } catch (copyFailure) {
      setCopied(false);
      setDrawerMode("handoff");
      setSelectedTerminal(terminal);
      setCopyError(
        copyFailure instanceof Error
          ? copyFailure.message
          : String(copyFailure),
      );
      throw copyFailure;
    }
  };

  const copySelectedContext = async (): Promise<void> => {
    if (!selectedTerminal) {
      return;
    }
    setCopyError(null);
    try {
      await copyText(buildHermesContext(selectedTerminal));
      setCopied(true);
    } catch (copyFailure) {
      setCopied(false);
      setCopyError(
        copyFailure instanceof Error
          ? copyFailure.message
          : String(copyFailure),
      );
    }
  };

  const copySelectedContextAndPromptFeishu = async (): Promise<void> => {
    await copySelectedContext();
  };

  const openFullTerminal = (terminalSessionId: string): void => {
    window.location.assign(
      `/terminal/${encodeURIComponent(terminalSessionId)}`,
    );
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto min-h-dvh max-w-[430px] bg-background">
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 px-4 pb-3 pt-4 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                onClick={() => {
                  window.location.assign("/");
                }}
                title="返回首页"
                aria-label="返回首页"
              >
                <Home className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold text-foreground">
                  Runweave 终端
                </h1>
                <p className="truncate text-xs text-muted-foreground">
                  {selectedSummary
                    ? `${selectedSummary.name} · ${selectedSummary.totalTerminals} 个终端 · ${selectedSummary.needsAttention} 个需要处理`
                    : "暂无项目"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <MobileThemeToggle />
              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                onClick={() => {
                  void loadOverview();
                }}
                title="刷新"
                aria-label="刷新"
              >
                <RefreshCw
                  className={["h-4 w-4", loading ? "animate-spin" : ""].join(
                    " ",
                  )}
                />
              </button>
            </div>
          </div>
        </header>

        <ProjectSwitcher
          projects={summaries}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
        />
        <TerminalStatusFilter value={filter} onChange={setFilter} />

        {error ? (
          <div className="mx-4 mt-3 rounded-xl border border-rose-300/60 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/45 dark:text-rose-200">
            {error}
          </div>
        ) : null}

        <section className="space-y-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
          {visibleCards.map((terminal) => (
            <TerminalCard
              key={terminal.terminalSessionId}
              terminal={terminal}
              onOpenDetail={openDetail}
              onOpenHandoff={openHandoff}
              onCopyContext={copyTerminalContext}
            />
          ))}

          {!loading && visibleCards.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/70 px-4 text-center shadow-sm">
              <Terminal className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-semibold text-foreground">
                没有匹配的终端
              </p>
            </div>
          ) : null}
        </section>
      </div>

      <TerminalDetailDrawer
        terminal={selectedTerminal}
        mode={drawerMode}
        copied={copied}
        copyError={copyError}
        onModeChange={(nextMode) => {
          setCopied(false);
          setCopyError(null);
          setDrawerMode(nextMode);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTerminal(null);
          }
        }}
        onCopy={copySelectedContext}
        onCopyAndPromptFeishu={copySelectedContextAndPromptFeishu}
        onOpenFullTerminal={openFullTerminal}
      />
    </main>
  );
}
