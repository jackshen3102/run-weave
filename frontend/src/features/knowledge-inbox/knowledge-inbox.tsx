import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import type { InboxItem, InboxState } from "@runweave/shared/knowledge-inbox";
import { Check, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  changeInboxState,
  fetchInbox,
  fetchInboxItem,
  inboxAccount,
} from "../../services/knowledge-inbox";
import { HttpError } from "../../services/http";
import { InboxDetail } from "./inbox-detail";

const retry = (count: number, error: Error) =>
  !(error instanceof HttpError && [401, 403, 404].includes(error.status)) &&
  count < 1;
function message(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 404) return "当前服务版本不支持，或内容已不可用";
    if (error.status === 409) return "内容或处理状态已变化，请刷新后重试";
    return error.message;
  }
  return "离线，显示最近缓存；连接恢复后请刷新";
}
export function KnowledgeInbox({
  apiBase,
  token,
}: {
  apiBase: string;
  token: string;
}) {
  const [state, setState] = useState<InboxState>("pending");
  const [repositoryId, setRepositoryId] = useState("");
  const [selected, setSelected] = useState<{
    itemId: string;
    version?: string;
  } | null>(null);
  const client = useQueryClient();
  const key = ["knowledge-inbox", apiBase, inboxAccount(token)];
  const query = useInfiniteQuery({
    queryKey: [...key, "list", state, repositoryId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchInbox(
        apiBase,
        token,
        { state, repositoryId, cursor: pageParam, limit: 20 },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.error instanceof HttpError && query.state.error.status === 404
        ? false
        : 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
    retry,
  });
  const detail = useQuery({
    queryKey: [...key, "detail", selected?.itemId, selected?.version],
    queryFn: ({ signal }) =>
      fetchInboxItem(
        apiBase,
        token,
        selected!.itemId,
        selected?.version,
        signal,
      ),
    enabled: !!selected,
    refetchInterval: (query) =>
      query.state.error instanceof HttpError && query.state.error.status === 404
        ? false
        : 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
    retry,
  });
  const refresh = useMemoizedFn(async () => {
    await client.invalidateQueries({ queryKey: key });
  });
  const mutation = useMutation({
    mutationFn: (item: InboxItem) =>
      changeInboxState(apiBase, token, item.itemId, {
        state: item.processedAt ? "pending" : "processed",
        expectedContentVersion: item.contentVersion,
        expectedStateVersion: item.stateVersion,
      }),
    onSuccess: async (item) => {
      setSelected(item.processedAt ? null : { itemId: item.itemId });
      await refresh();
    },
    onError: async () => {
      await refresh();
    },
  });
  const pages = query.data?.pages ?? [];
  const items = [
    ...new Map(
      pages.flatMap((page) => page.items).map((item) => [item.itemId, item]),
    ).values(),
  ];
  const partial = pages.some((page) => page.sourceStatus.status === "partial");
  const error = mutation.error ?? detail.error ?? query.error;
  const choose = useMemoizedFn((item: InboxItem) => {
    mutation.reset();
    setSelected({
      itemId: item.itemId,
      version: item.processedAt ? item.contentVersion : undefined,
    });
  });
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-5 md:p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Sparkles className="h-6 w-6" />
            自进化
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            阅读项目中的发现与经验，按自己的节奏处理。
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          aria-label="刷新成果"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>
      <div className="flex flex-wrap gap-3">
        {(
          [
            ["pending", "待处理"],
            ["processed", "已处理"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={state === value ? "default" : "outline"}
            aria-pressed={state === value}
            onClick={() => {
              setState(value);
              setSelected(null);
              mutation.reset();
            }}
          >
            {label}
          </Button>
        ))}
        <select
          aria-label="筛选项目"
          className="rounded-md border border-input bg-background px-3 text-sm"
          value={repositoryId}
          onChange={(event) => {
            setRepositoryId(event.target.value);
            setSelected(null);
          }}
        >
          <option value="">全部项目</option>
          {pages[0]?.repositories.map((repo) => (
            <option value={repo.repositoryId} key={repo.repositoryId}>
              {repo.displayName}
            </option>
          ))}
        </select>
      </div>
      {partial ? (
        <p
          role="status"
          className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
        >
          部分来源暂不可用，当前列表不完整。
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm">
          {message(error)}
        </p>
      ) : null}
      <div className={`grid gap-5 ${selected ? "lg:grid-cols-2" : ""}`}>
        <div className="space-y-3">
          {query.isPending ? (
            <p className="py-12 text-center text-muted-foreground">
              正在读取成果…
            </p>
          ) : null}
          {!query.isPending && !error && !partial && !items.length ? (
            <p className="py-16 text-center text-muted-foreground">
              {state === "pending" ? "当前没有待处理成果" : "暂无处理历史"}
            </p>
          ) : null}
          {items.map((item) => (
            <button
              key={item.itemId}
              type="button"
              onClick={() => choose(item)}
              className="w-full space-y-3 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {item.projectName} ·{" "}
                  {item.source === "experience" ? "经验" : "洞察"}
                </span>
                {item.hasUpdate ? (
                  <span className="text-amber-600">有更新</span>
                ) : item.processedAt ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </div>
              <h2 className="font-medium">{item.title}</h2>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {item.statement || item.actions?.[0] || item.applicability}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(item.contentUpdatedAt).toLocaleString()}
                {item.availability !== "available" ? " · 不可用" : ""}
              </p>
            </button>
          ))}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多
            </Button>
          ) : null}
        </div>
        {selected ? (
          <div className="space-y-3">
            <Button variant="ghost" onClick={() => setSelected(null)}>
              关闭详情
            </Button>
            {detail.isPending ? (
              <p>正在读取详情…</p>
            ) : detail.data ? (
              <InboxDetail
                key={`${apiBase}:${inboxAccount(token)}:${detail.data.itemId}:${detail.data.contentVersion}:${detail.data.sourceRevision}`}
                apiBase={apiBase}
                token={token}
                item={detail.data}
                busy={mutation.isPending}
                disabled={!!query.error || !!detail.error || !navigator.onLine}
                onChange={() => {
                  if (detail.data!.currentContentVersion)
                    setSelected({ itemId: detail.data!.itemId });
                  else mutation.mutate(detail.data!);
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
