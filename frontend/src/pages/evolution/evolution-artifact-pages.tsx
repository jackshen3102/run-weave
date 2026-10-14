import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  EvolutionArtifactCollection,
  EvolutionArtifactPage,
} from "@runweave/shared/evolution";
import { fetchEvolutionArtifactPage } from "../../services/evolution";
import { Button } from "../../components/ui/button";

const collections: Array<{
  value: EvolutionArtifactCollection;
  label: string;
}> = [
  { value: "evidence", label: "冻结证据" },
  { value: "data-quality", label: "质量记录" },
  { value: "segments", label: "轨迹片段" },
  { value: "episodes", label: "任务片段" },
];

export function EvolutionArtifactPages({
  apiBase,
  token,
  runId,
}: {
  apiBase: string;
  token: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  const [collection, setCollection] =
    useState<EvolutionArtifactCollection>("evidence");
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const cursor = cursors[cursors.length - 1];
  const page = useQuery({
    queryKey: [
      "evolution",
      "artifact-page",
      apiBase,
      token,
      runId,
      collection,
      cursor,
    ],
    queryFn: () =>
      fetchEvolutionArtifactPage(apiBase, token, runId, { collection, cursor }),
    enabled: open,
    refetchOnWindowFocus: false,
    gcTime: 0,
    retry: false,
  });
  return (
    <section className="rounded-lg border border-border/70 p-3">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起详细记录" : "查看详细记录"}
      </Button>
      {open ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2" aria-label="详细记录类型">
            {collections.map(({ value, label }) => (
              <Button
                key={value}
                size="sm"
                variant={collection === value ? "secondary" : "outline"}
                aria-pressed={collection === value}
                onClick={() => {
                  setCollection(value);
                  setCursors([undefined]);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {page.isFetching ? (
            <p className="text-xs text-muted-foreground">正在读取详细记录…</p>
          ) : null}
          {page.error ? (
            <div role="alert" className="text-xs text-destructive">
              读取失败：{page.error.message}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void page.refetch()}
              >
                重试读取
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCursors([undefined])}
              >
                返回首页
              </Button>
            </div>
          ) : null}
          {page.data ? (
            <>
              <p className="text-xs text-muted-foreground">
                共 {page.data.total} 条 · 第 {cursors.length} 页 · 本页{" "}
                {page.data.items.length} 条
              </p>
              <div className="space-y-2">
                {page.data.items.map((item, index) => (
                  <ArtifactRecord
                    key={`${collection}:${cursor ?? "first"}:${index}`}
                    item={item}
                    index={index}
                  />
                ))}
                {page.data.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无记录</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursors.length === 1 || page.isFetching}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!page.data.nextCursor || page.isFetching}
                  onClick={() =>
                    setCursors([...cursors, page.data!.nextCursor!])
                  }
                >
                  下一页
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ArtifactRecord({
  item,
  index,
}: {
  item: EvolutionArtifactPage["items"][number];
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const id =
    "evidenceId" in item
      ? item.evidenceId
      : "segmentId" in item
        ? item.segmentId
        : "episodeId" in item
          ? item.episodeId
          : "code" in item
            ? item.code
            : index + 1;
  return (
    <details
      className="rounded-md bg-muted/45 p-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer break-all text-xs">
        {String(id)}
      </summary>
      {open ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(item, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}
