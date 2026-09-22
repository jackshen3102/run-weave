import type { InboxItem } from "@runweave/shared/knowledge-inbox";
import { Button } from "../../components/ui/button";
export function InboxDetail({
  item,
  busy,
  disabled,
  onChange,
}: {
  item: InboxItem;
  busy: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <article className="space-y-5 rounded-2xl border border-border bg-card p-6">
      <div>
        <p className="text-xs text-muted-foreground">
          {item.projectName} · {item.source === "experience" ? "经验" : "洞察"}
        </p>
        <h2 className="mt-2 text-xl font-semibold">{item.title}</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {item.validationLabel} ·{" "}
          {new Date(item.contentUpdatedAt).toLocaleString()}
        </p>
      </div>
      {item.availability !== "available" ? (
        <p role="status" className="text-amber-600">
          {item.availability === "unknown" ? "来源暂不可用" : "已失效 / 不可用"}
        </p>
      ) : null}
      {item.currentContentVersion ? (
        <p className="text-amber-600">
          这是处理时的正文，当前已有新版本{item.hasUpdate ? "待处理" : ""}。
        </p>
      ) : null}
      {/* Plain text deliberately excludes raw HTML, scripts and remote-image loading. */}
      {item.statement ? (
        <p className="whitespace-pre-wrap text-sm leading-7">
          {item.statement}
        </p>
      ) : null}
      {item.applicability ? (
        <section>
          <h3 className="font-medium">适用条件</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
            {item.applicability}
          </p>
        </section>
      ) : null}
      {(
        [
          ["guidance", "建议"],
          ["actions", "步骤"],
          ["avoid", "避坑"],
          ["verification", "验证说明"],
        ] as const
      ).map(([key, label]) =>
        item[key]?.length ? (
          <section key={key}>
            <h3 className="font-medium">{label}</h3>
            <ol className="mt-2 list-inside list-decimal space-y-2 text-sm leading-7">
              {item[key]!.map((value, index) => (
                <li key={index} className="whitespace-pre-wrap">
                  {value}
                </li>
              ))}
            </ol>
          </section>
        ) : null,
      )}
      <Button
        onClick={onChange}
        disabled={busy || disabled || item.availability !== "available"}
      >
        {busy
          ? "正在保存…"
          : item.processedAt
            ? item.currentContentVersion
              ? "查看当前版本"
              : "恢复待处理"
            : "已处理"}
      </Button>
    </article>
  );
}
