import { useEffect, useRef, useState } from "react";
import { useDebounce, useMemoizedFn } from "ahooks";
import {
  Plus,
  Search,
  NotebookPen,
  ListChecks,
  Trash2,
  Sparkles,
} from "lucide-react";
import type {
  RecordPage,
  RecordResponse,
  ReviewScope,
  SuijiRecord,
} from "@runweave/shared/suiji";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SuijiHttpError } from "../../services/suiji";
import type { SuijiConnection } from "./connection-model";
import type { PendingRequest, SuijiDraft } from "./drafts";
import { SuijiEditorModel } from "./editor-model";
import { SuijiEditor } from "./editor";
import {
  RecordBody,
  recordDate,
  statusText,
  SuijiRecordDetail,
} from "./record";
import { SuijiReviewPanel } from "./review";

export function SuijiWorkspace({
  connection,
  onOpenLink,
}: {
  connection: SuijiConnection;
  onOpenLink?: (url: string) => void;
}) {
  const { client, info, store } = connection;
  const [tab, setTab] = useState("records"),
    [kind, setKind] = useState(""),
    [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const search = useDebounce(query, { wait: 250 });
  const detailRequest = useRef(0);
  const [items, setItems] = useState<SuijiRecord[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [message, setMessage] = useState("");
  const [detail, setDetail] = useState<{
    record: SuijiRecord;
    citedVersion?: number;
  }>();
  const [editor, setEditor] = useState<SuijiEditorModel>();
  const [scope, setScope] = useState<ReviewScope>({ kind: "all" });
  const [pending, setPending] = useState<Set<string>>(new Set()),
    [statusBusy, setStatusBusy] = useState(false);
  const [writable, setWritable] = useState(false);
  const alive = useRef(true),
    generation = useRef(0),
    acquiring = useRef(false);
  const release = useRef<(() => void) | undefined>(undefined),
    models = useRef(new Map<string, SuijiEditorModel>());
  const acquire = useMemoizedFn(async () => {
    if (acquiring.current || !navigator.locks) return;
    acquiring.current = true;
    try {
      await navigator.locks.request(
        "suiji-editor:" + store.scope,
        { ifAvailable: true },
        async (lock) => {
          if (!lock || !alive.current) return;
          setWritable(true);
          await new Promise<void>((resolve) => {
            release.current = resolve;
          });
        },
      );
    } finally {
      acquiring.current = false;
    }
  });
  useEffect(() => {
    alive.current = true;
    void acquire();
    const owned = models.current;
    return () => {
      alive.current = false;
      owned.forEach((m) => m.dispose());
      void Promise.all([...owned.values()].map((m) => m.settled())).finally(
        () => {
          release.current?.();
          store.close();
        },
      );
    };
  }, [acquire, store]);
  const load = useMemoizedFn(async (more = false) => {
    if (tab === "ai" || (more && (!cursor || loading))) return;
    const sequence = ++generation.current;
    setLoading(true);
    setMessage("");
    if (!more) {
      setItems([]);
      setCursor(null);
    }
    const query = new URLSearchParams();
    if (tab === "tasks") {
      query.set("kind", "task");
      query.set("taskStatus", status);
    } else if (kind) query.set("kind", kind);
    if (tab === "trash") query.set("trash", "true");
    if (search) query.set("q", search);
    if (more && cursor) query.set("cursor", cursor);
    try {
      const page = await client.request<RecordPage>(
        "/api/suiji/v1/records?" + query,
      );
      if (!alive.current || sequence !== generation.current) return;
      const pendingIds = await Promise.all(
        page.items.map(async (r) =>
          (await store.get("status:" + r.id)) ? r.id : undefined,
        ),
      );
      if (!alive.current || sequence !== generation.current) return;
      setItems((old) =>
        more
          ? [
              ...old,
              ...page.items.filter((r) => !old.some((o) => o.id === r.id)),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
      setPending(
        (old) =>
          new Set([
            ...(more ? old : []),
            ...pendingIds.filter((id): id is string => Boolean(id)),
          ]),
      );
    } catch (error) {
      if (alive.current && sequence === generation.current)
        setMessage(error instanceof Error ? error.message : "读取失败");
    } finally {
      if (alive.current && sequence === generation.current) setLoading(false);
    }
  });
  useEffect(() => {
    void load();
  }, [load, tab, kind, status, search]);
  const open = useMemoizedFn(async (id: string, citedVersion?: number) => {
    const sequence = generation.current;
    const request = ++detailRequest.current;
    try {
      const { record } = await client.request<RecordResponse>(
        "/api/suiji/v1/records/" + id,
      );
      const operation = await store.get("status:" + id);
      if (
        !alive.current ||
        sequence !== generation.current ||
        request !== detailRequest.current
      )
        return;
      setPending((old) => {
        const next = new Set(old);
        if (operation) next.add(id);
        else next.delete(id);
        return next;
      });
      setDetail({ record, citedVersion });
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : "读取失败");
    }
  });
  const edit = useMemoizedFn(
    async (
      record?: SuijiRecord,
      defaultKind: "note" | "task" = "task",
      body = "",
    ) => {
      if (!writable || record?.deletedAt) return;
      try {
        if (record && (await store.get("status:" + record.id)))
          throw new Error("状态操作待确认，请先手动确认");
        const id = record?.id ?? "new";
        let model = models.current.get(id);
        if (model && body)
          setMessage(
            "已恢复原有草稿；新结论未覆盖它。请先处理当前草稿，再另存结论。",
          );
        if (!model) {
          const restored = await store.get<SuijiDraft>("draft:" + id);
          if (!alive.current) return;
          const draft = restored ?? {
            id,
            kind: record?.kind ?? defaultKind,
            body: record?.body ?? body,
            version: record?.version,
            existing: record?.attachments ?? [],
            files: [],
          };
          model = new SuijiEditorModel(draft, client, store);
          models.current.set(id, model);
          if (restored && body)
            setMessage(
              "已恢复原有草稿；新结论未覆盖它。请先处理当前草稿，再另存结论。",
            );
          await model.initialize();
        }
        if (alive.current) {
          setEditor(model);
        }
      } catch (error) {
        if (alive.current)
          setMessage(error instanceof Error ? error.message : "草稿读取失败");
      }
    },
  );
  const changeRecord = useMemoizedFn(
    async (
      record: SuijiRecord,
      action:
        | { targetStatus: "open" | "done" | "archived" }
        | { trashed: boolean },
    ) => {
      if (!writable || statusBusy) return;
      setStatusBusy(true);
      setMessage("");
      try {
        const previous = await store.get<PendingRequest>("status:" + record.id);
        if (
          !previous &&
          (await store.get<SuijiDraft>("draft:" + record.id))?.frozen
        )
          throw new Error("正文保存结果待确认，请先在编辑器确认");
        const operation = previous ?? {
          path: `/api/suiji/v1/records/${record.id}/${"trashed" in action ? "trash" : "task-status"}`,
          method: "POST",
          key: crypto.randomUUID(),
          data: { expectedVersion: record.version, ...action },
        };
        await store.set("status:" + record.id, operation);
        if (!alive.current) return;
        setPending((old) => new Set([...old, record.id]));
        const result = await client.request<RecordResponse>(
          operation.path,
          operation.method,
          operation.data,
          operation.key,
        );
        if (!alive.current) return;
        await store.remove("status:" + record.id);
        setPending((old) => {
          const next = new Set(old);
          next.delete(record.id);
          return next;
        });
        setDetail((current) => {
          if (current?.record.id !== record.id) return current;
          return operation.path.endsWith("/trash") ||
            result.record.taskStatus === "done"
            ? undefined
            : { record: result.record };
        });
        await load();
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof SuijiHttpError && !error.uncertain) {
          try {
            await store.remove("status:" + record.id);
            setPending((old) => {
              const next = new Set(old);
              next.delete(record.id);
              return next;
            });
          } catch {
            setMessage("本机状态确认写入失败，请手动重试");
            return;
          }
        }
        setMessage(error instanceof Error ? error.message : "状态结果待确认");
      } finally {
        if (alive.current) setStatusBusy(false);
      }
    },
  );
  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <div
        className={detail || editor ? "hidden" : "flex min-h-0 flex-1 flex-col"}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4">
          {!writable ? (
            <div className="flex items-center justify-between gap-4 rounded-xl border p-4 text-sm">
              <p>另一随记页面正在编辑，当前可浏览。关闭那一页后可接管编辑。</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void acquire()}
              >
                接管编辑
              </Button>
            </div>
          ) : null}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <div hidden={tab !== "ai"} className="pb-6">
            <SuijiReviewPanel
              client={client}
              info={info}
              scope={scope}
              onScope={setScope}
              onOpen={(id, version) => void open(id, version)}
              onSave={(body, type) => void edit(undefined, type, body)}
              writable={writable}
            />
          </div>
          {tab !== "ai" ? (
            <>
              <section className="mb-4 flex flex-wrap items-center justify-between gap-3">
                {tab === "tasks" ? (
                  <label className="flex items-center gap-3 text-sm">
                    状态
                    <select
                      aria-label="待办状态"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                      className="rounded-xl border bg-card p-2"
                    >
                      <option value="open">未完成</option>
                      <option value="done">已完成</option>
                      <option value="archived">不再做</option>
                    </select>
                  </label>
                ) : (
                  <div className="flex items-center gap-3 text-sm">
                    <div
                      role="group"
                      aria-label="类型筛选"
                      className="inline-flex gap-1 rounded-xl bg-secondary p-1"
                    >
                      {(
                        [
                          ["", "全部"],
                          ["note", "想法"],
                          ["task", "待办"],
                        ] as const
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          type="button"
                          size="sm"
                          variant={kind === value ? "default" : "ghost"}
                          aria-pressed={kind === value}
                          onClick={() => setKind(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="搜索记录"
                  aria-pressed={searchVisible}
                  onClick={() => {
                    if (searchVisible) setQuery("");
                    setSearchVisible((value) => !value);
                  }}
                >
                  <Search className="size-4" />
                </Button>
                {searchVisible ? (
                  <Input
                    autoFocus
                    aria-label="搜索原文"
                    placeholder="搜索正文关键词"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full"
                  />
                ) : null}
              </section>
              <section className="flex flex-col gap-4 pb-20">
                {items
                  .filter(
                    (record) =>
                      tab !== "records" ||
                      record.taskStatus !== "done" ||
                      pending.has(record.id),
                  )
                  .map((record) => (
                    <article
                      key={record.id}
                      className="relative flex flex-col gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent"
                    >
                      <button
                        type="button"
                        aria-label={`查看记录：${record.body || "附件记录"}`}
                        onClick={() => void open(record.id)}
                        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <span className="pointer-events-none relative flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>
                          {statusText(record)}
                          {pending.has(record.id) ? " · 状态待确认" : ""}
                        </span>
                        <time>{recordDate(record.createdAt)}</time>
                      </span>
                      <RecordBody
                        onOpenLink={onOpenLink}
                        body={record.body || "附件记录"}
                        className="pointer-events-none relative line-clamp-5"
                      />
                      {record.attachments.length ? (
                        <span className="pointer-events-none relative text-xs text-muted-foreground">
                          {record.attachments
                            .map((a) => a.fileName)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </article>
                  ))}
                {loading ? (
                  <p
                    role="status"
                    className="py-8 text-center text-muted-foreground"
                  >
                    正在读取记录…
                  </p>
                ) : items.filter(
                    (record) =>
                      tab !== "records" ||
                      record.taskStatus !== "done" ||
                      pending.has(record.id),
                  ).length === 0 ? (
                  <div className="flex flex-col gap-3 py-16 text-center">
                    <h2 className="text-xl">
                      {query
                        ? "没有找到匹配的原文"
                        : tab === "trash"
                          ? "回收站为空"
                          : "留一点想法在这里"}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {query
                        ? "试试更短的关键词。"
                        : tab === "trash"
                          ? "删除的记录会保留在这里，可随时恢复。"
                          : "点右下角加号，记下一句想到的事。"}
                    </p>
                  </div>
                ) : null}
                <div className="flex justify-center gap-3">
                  <Button
                    variant="ghost"
                    disabled={loading}
                    onClick={() => void load()}
                  >
                    刷新
                  </Button>
                  {cursor ? (
                    <Button
                      variant="outline"
                      disabled={loading}
                      onClick={() => void load(true)}
                    >
                      加载更多
                    </Button>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
        {tab !== "trash" && tab !== "ai" ? (
          <Button
            aria-label="新增记录"
            className="absolute bottom-20 right-5 size-12 rounded-full shadow-lg"
            disabled={!writable}
            onClick={() => void edit()}
          >
            <Plus />
          </Button>
        ) : null}
        <nav
          aria-label="随记导航"
          className="grid shrink-0 grid-cols-4 border-t bg-background px-2 py-2"
        >
          {(
            [
              ["records", "记录", NotebookPen],
              ["tasks", "待办", ListChecks],
              ["trash", "回收站", Trash2],
              ["ai", "AI", Sparkles],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              type="button"
              key={value}
              aria-current={tab === value ? "page" : undefined}
              className={`flex flex-col items-center gap-1 rounded-lg py-2 text-xs ${tab === value ? "bg-secondary text-primary" : "text-muted-foreground hover:bg-accent"}`}
              onClick={() => {
                ++generation.current;
                setTab(value);
              }}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </nav>
      </div>
      {detail && !editor ? (
        <SuijiRecordDetail
          onOpenLink={onOpenLink}
          {...detail}
          client={client}
          onClose={() => setDetail(undefined)}
          onEdit={() => void edit(detail.record)}
          onStatus={(target) =>
            void changeRecord(detail.record, { targetStatus: target })
          }
          onTrash={(trashed) => void changeRecord(detail.record, { trashed })}
          onReview={() => {
            setScope({ kind: "record", recordId: detail.record.id });
            setDetail(undefined);
            setTab("ai");
          }}
          onRecreate={() => void edit(undefined, "task", detail.record.body)}
          writable={writable}
          pending={pending.has(detail.record.id)}
          busy={statusBusy}
        />
      ) : null}
      {editor ? (
        <SuijiEditor
          model={editor}
          onClose={() => setEditor(undefined)}
          onDiscard={() => {
            models.current.delete(editor.state.draft.id);
            editor.dispose();
            setEditor(undefined);
          }}
          onSaved={(record) => {
            if (detail) setDetail({ record });
            models.current.delete(editor.state.draft.id);
            editor.dispose();
            setEditor(undefined);
            void load();
          }}
        />
      ) : null}
    </main>
  );
}
