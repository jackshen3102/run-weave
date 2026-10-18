import { fetchTaskHandoff } from "../../../services/task-handoff";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useQueryClient } from "@tanstack/react-query";
import { terminalQueryKeys } from "../../../features/terminal/queries/keys";
import type { RecordResponse, SuijiRecord } from "@runweave/shared/suiji";
import type {
  TaskHandoffCard,
  TaskHandoffTarget,
} from "@runweave/shared/task-handoff";
import { Link2 } from "lucide-react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { useSuijiConnection } from "../../../features/suiji/connection-provider";
import { useSettingsNavigation } from "../../../features/settings/navigation";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { getTerminalConversation } from "../../../services/terminal/conversation";
import { useHandoffLinks } from "../../../features/terminal/handoff/use-context-link";
import {
  handoffContextLinks,
  sameHandoffTarget,
  type LocalHandoffLink,
  type ObservedHandoffSource,
} from "../../../features/terminal/handoff/context-link-store";
import { useConversation } from "../../../features/terminal/conversation/use-conversation";
import { SuijiLinkDialog } from "./suiji-link-dialog";
import { HandoffSourceReader } from "./source-reader";
import { HandoffOriginLink } from "./origin-link";

export function HandoffContextLinks({
  target,
  card,
  completion,
}: {
  target: TaskHandoffTarget;
  card: TaskHandoffCard | null;
  completion?: number;
}) {
  const runtime = useTerminalRuntime();
  const queryClient = useQueryClient();
  useEffect(() => {
    // Native history can bind a new thread after the session list was fetched.
    // Refresh that list when this visible handoff resolves a different target.
    void queryClient.invalidateQueries({ queryKey: terminalQueryKeys.sessions(runtime.scope) });
  }, [queryClient, runtime.scope, target.threadId, target.panelId]);
  const suiji = useSuijiConnection();
  const context = useHandoffLinks();
  const settings = useSettingsNavigation();
  const projectId = useTerminalWorkspaceStore((state) => state.activeProjectId);
  const { ensure } = suiji;
  useEffect(() => {
    void ensure();
  }, [ensure]);
  const links = context.links;
  const link = links.find(
    (item) =>
      item.projectId === projectId && sameHandoffTarget(item.target, target),
  );
  const [picker, setPicker] = useState(false);
  const [reader, setReader] = useState(false);
  const [recordState, setRecordState] = useState<{
    linkId: string;
    record: SuijiRecord;
    readAt: string;
  } | null>(null);
  const [sources, setSources] = useState<{
    scope: string;
    items: ObservedHandoffSource[];
  }>({ scope: "", items: [] });
  const [selectedSource, setSelectedSource] =
    useState<ObservedHandoffSource | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const current = useRef({
    scope: runtime.scope,
    account: context.scope,
    target,
  });
  current.current = { scope: runtime.scope, account: context.scope, target };
  const valid = useMemoizedFn(
    () =>
      context.isCurrent() &&
      runtime.scope === current.current.scope &&
      sameHandoffTarget(target, current.current.target),
  );
  const record =
    link &&
    recordState?.linkId === link.linkId &&
    suiji.connection?.client.active
      ? recordState.record
      : null;
  const readRecord = useMemoizedFn(async () => {
    const client = suiji.connection?.client;
    const ticket = ++sequence.current;
    if (!link || !client) return;
    setError("");
    setBusy(true);
    try {
      const response = await client.request<RecordResponse>(
        `/api/suiji/v1/records/${encodeURIComponent(link.suiji.recordId)}`,
      );
      if (ticket === sequence.current && valid())
        setRecordState(response.record.deletedAt ? null : {
          linkId: link.linkId,
          record: response.record,
          readAt: new Date().toISOString(),
        });
    } catch (cause) {
      if (ticket === sequence.current && valid()) {
        if (
          cause &&
          typeof cause === "object" &&
          "status" in cause &&
          (cause.status === 401 || cause.status === 404)
        )
          setRecordState(null);
        if (
          cause &&
          typeof cause === "object" &&
          "status" in cause &&
          cause.status === 401
        )
          suiji.editAccount();
        setError(cause instanceof Error ? cause.message : "原文暂不可读");
      }
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  });
  useEffect(() => {
    const counter = sequence;
    setPicker(false);
    setReader(false);
    setRecordState(null);
    setSelectedSource(null);
    setError("");
    if (link) void readRecord();
    return () => {
      ++counter.current;
    };
  }, [link, context.scope, readRecord]);
  useEffect(() => {
    if (!link || !context.scope) return;
    let cancelled = false;
    const relevant = links.filter(
      (item) =>
        item.suiji.recordId === link.suiji.recordId &&
        item.linkId !== link.linkId,
    );
    void handoffContextLinks
      .sources(relevant)
      .then((items) => {
        if (!cancelled && valid()) setSources({ scope: context.scope, items });
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "来源读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [link, links, context.scope, valid]);
  const observe = useMemoizedFn(() => {
    if (!link || !card || !valid()) return;
    void handoffContextLinks
      .observe(link, card, target.terminalSessionId, valid)
      .catch((cause) => {
        if (valid())
          setError(cause instanceof Error ? cause.message : "成果摘录未保存");
      });
  });
  useEffect(() => {
    observe();
  }, [link?.linkId, card?.revision, observe]);
  const refreshRelated = useMemoizedFn(
    async (source: ObservedHandoffSource) => {
      const related = links.find((item) => item.linkId === source.linkId);
      if (!related || !valid()) return;
      const expectedAccount = context.scope;
      const stillCurrent = () =>
        valid() && current.current.account === expectedAccount;
      setBusy(true);
      setError("");
      try {
        const original = await getTerminalConversation(
          runtime.apiBase,
          runtime.token,
          related.target.terminalSessionId,
          {
            panelId: related.target.panelId,
            expectedThreadId: related.target.threadId,
          },
          AbortSignal.timeout(10_000),
        );
        if (
          !stillCurrent() ||
          !original.target ||
          !sameHandoffTarget(original.target, related.target)
        )
          throw new Error("原会话当前不可用；保留上次读取的成果");
        const response = await fetchTaskHandoff(
          runtime.apiBase,
          runtime.token,
          related.target.terminalSessionId,
          related.target.panelId,
        );
        if (
          !stillCurrent() ||
          !response.card ||
          !sameHandoffTarget(response.card.target, related.target)
        )
          throw new Error("原会话成果尚不可读；保留上次摘录");
        await handoffContextLinks.observe(
          related,
          response.card,
          source.sessionName,
          stillCurrent,
        );
        const updated = await handoffContextLinks.sources(
          links.filter(
            (item) =>
              item.suiji.recordId === related.suiji.recordId &&
              item.linkId !== link?.linkId,
          ),
        );
        if (stillCurrent()) {
          setSources({ scope: context.scope, items: updated });
          setSelectedSource(
            updated.find((item) => item.linkId === related.linkId) ?? null,
          );
        }
      } catch (cause) {
        if (stillCurrent())
          setError(cause instanceof Error ? cause.message : "原会话当前不可用");
      } finally {
        if (stillCurrent()) setBusy(false);
      }
    },
  );
  const associate = useMemoizedFn(async () => {
    setPicker(true);
    await suiji.ensure();
  });
  const confirm = useMemoizedFn(async (selected: SuijiRecord) => {
    if (!context.account || !projectId || !valid())
      throw new Error("账号或会话已切换，请重新选择");
    const expected = { ...current.current };
    const response = await getTerminalConversation(
      runtime.apiBase,
      runtime.token,
      target.terminalSessionId,
      { panelId: target.panelId, expectedThreadId: target.threadId },
      AbortSignal.timeout(10_000),
    );
    const stillCurrent = () =>
      valid() &&
      current.current.account === expected.account &&
      current.current.scope === expected.scope &&
      sameHandoffTarget(current.current.target, expected.target);
    if (
      !stillCurrent() ||
      !response.target ||
      !sameHandoffTarget(response.target, target)
    )
      throw new Error("原会话已变化，未保存关联");
    const next: LocalHandoffLink = {
      schemaVersion: 1,
      linkId: crypto.randomUUID(),
      backend: context.backend,
      target,
      projectId,
      suiji: { ...context.account, recordId: selected.id },
      confirmedSource: {
        recordVersion: selected.version,
        latestFollowupSequence: selected.followupSummary?.latest?.sequence ?? 0,
      },
      revision: 1,
      linkedAt: new Date().toISOString(),
    };
    await handoffContextLinks.create(
      next,
      stillCurrent,
      card ? { card, sessionName: target.terminalSessionId } : undefined,
    );
    await context.reload();
  });
  const unlink = useMemoizedFn(async () => {
    if (!link || busy) return;
    setBusy(true);
    setError("");
    try {
      await handoffContextLinks.remove(link, valid);
      await context.reload();
    } catch (cause) {
      if (valid())
        setError(cause instanceof Error ? cause.message : "解除失败");
    } finally {
      setBusy(false);
    }
  });
  return (
    <div className="flex min-w-0 flex-col gap-5" aria-label="会话来源与关联">
      {reader && record ? (
        <HandoffSourceReader
          key={`${context.scope}:${record.id}`}
          record={record}
          back={() => setReader(false)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs text-slate-400">关联随记</h3>
            {link ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void unlink()}
              >
                解除关联
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={suiji.busy && !!suiji.accounts}
                onClick={() => void associate()}
              >
                <Link2 data-icon="inline-start" />
                关联随记
              </Button>
            )}
          </div>
          {picker && !suiji.connection ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-slate-400">
                {suiji.busy
                  ? "正在恢复随记账户…"
                  : suiji.message || "请先登录随记，再关联现有记录。"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => settings("suiji")}
              >
                打开随记账户
              </Button>
            </div>
          ) : null}
          {!link ? (
            <p className="text-xs text-slate-500">当前会话未关联随记。</p>
          ) : record ? (
            <div className="flex min-w-0 flex-col gap-3 rounded-md border border-slate-800 p-3">
              <p className="whitespace-pre-wrap break-words text-xs leading-6">
                {record.body.slice(0, 1000)}
                {record.body.length > 1000 ? "…（摘录）" : ""}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-slate-400">
                  {record.kind === "task"
                    ? { open: "未完成", done: "已完成", archived: "不再做" }[
                        record.taskStatus ?? "open"
                      ]
                    : "想法"}{" "}
                  · 读取于 {new Date(recordState!.readAt).toLocaleTimeString()}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setReader(true)}
                >
                  查看原文与跟进
                </Button>
              </div>
              {record.followupSummary?.latest ? (
                <div className="border-t border-slate-800 pt-3">
                  <p className="mb-2 text-[10px] text-slate-400">
                    最新跟进 ·{" "}
                    {record.followupSummary.latest.source.actor === "app"
                      ? "你"
                      : record.followupSummary.latest.source.agentName ||
                        "Agent"}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-6">
                    {record.followupSummary.latest.excerpt}
                  </p>
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void readRecord()}
              >
                刷新原文与补充
              </Button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              {busy ? "正在读取关联随记…" : "关联仍保留，原文当前不可读。"}
            </p>
          )}
          {error || context.error ? (
            <p role="status" className="text-xs text-amber-200">
              {error || context.error}
            </p>
          ) : null}
          <HandoffCurrentInput
            target={target}
            completion={completion}
            projectId={projectId ?? ""}
          />
          {link && sources.scope === context.scope && sources.items.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs text-slate-400">相关会话成果</h3>
              {sources.items.map((source) => (
                <Button
                  key={source.linkId}
                  variant="ghost"
                  className="h-auto justify-start whitespace-normal text-left"
                  onClick={() => setSelectedSource(source)}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate">{source.card.goal}</span>
                    <span className="text-[10px] text-slate-500">
                      上次读取 · {new Date(source.observedAt).toLocaleString()}{" "}
                      · {source.sessionName}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {picker && suiji.connection ? (
        <SuijiLinkDialog
          open
          close={() => setPicker(false)}
          confirm={confirm}
        />
      ) : null}
      <Dialog
        open={
          !!selectedSource &&
          links.some((item) => item.linkId === selectedSource.linkId)
        }
        onOpenChange={(open) => {
          if (!open) setSelectedSource(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[80vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>上次读取的会话成果</DialogTitle>
          </DialogHeader>
          {selectedSource ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void refreshRelated(selectedSource)}
              >
                刷新原会话成果
              </Button>
              {error ? (
                <p role="status" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                读取于 {new Date(selectedSource.observedAt).toLocaleString()}
                ；会话报告不代表独立验收。
              </p>
              {selectedSource.card.results.map((item, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-2 rounded-md border p-3"
                >
                  <p className="whitespace-pre-wrap break-words text-xs">
                    {item.text}
                  </p>
                  {selectedSource.card.evidence
                    .filter((entry) => item.evidenceIds.includes(entry.id))
                    .map((entry) => (
                      <div key={entry.id} className="flex flex-col gap-2">
                        <pre className="whitespace-pre-wrap break-words text-xs">
                          {entry.text}
                        </pre>
                        {entry.origin ? (
                          <HandoffOriginLink
                            origin={entry.origin}
                            projectId={
                              links.find(
                                (item) => item.linkId === selectedSource.linkId,
                              )?.projectId ?? ""
                            }
                            isCurrent={() =>
                              valid() &&
                              current.current.account === context.scope
                            }
                            onOpened={() => setSelectedSource(null)}
                          />
                        ) : null}
                      </div>
                    ))}
                </div>
              ))}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HandoffCurrentInput({
  target,
  completion,
  projectId,
}: {
  target: TaskHandoffTarget;
  completion?: number;
  projectId: string;
}) {
  const { data, error, load } = useConversation(
    target.terminalSessionId,
    target.panelId,
    target.threadId,
  );
  useEffect(() => {
    if (completion) void load();
  }, [completion, load]);
  const message =
    data?.target && sameHandoffTarget(data.target, target)
      ? data.turns
          .flatMap((turn) => turn.messages)
          .filter(
            (item) =>
              item.role === "user" &&
              !item.text.includes("[runweave-task-supervision:") &&
              !item.text.startsWith("# AGENTS.md instructions for") &&
              !item.text.includes("<environment_context>"),
          )
          .at(-1)
      : undefined;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs text-slate-400">本轮最新输入</h3>
      {message ? (
        <>
          <blockquote className="whitespace-pre-wrap break-words border-l-2 border-slate-700 pl-3 text-xs leading-6">
            {message.text.slice(0, 2000)}
            {message.text.length > 2000 ? "…（摘录）" : ""}
          </blockquote>
          <HandoffOriginLink
            origin={{ target, provider: "codex", messageId: message.id }}
            projectId={projectId}
          />
        </>
      ) : (
        <p className="text-xs text-slate-500">
          {error || "当前原生输入尚不可读。"}
        </p>
      )}
    </section>
  );
}
