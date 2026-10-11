import { Copy } from "lucide-react";
import { useMemoizedFn } from "ahooks";
import {
  RUNTIME_VERSION_FACT_PREFIX,
  runtimeBuildInfo,
  runtimeVersionFacts,
} from "@runweave/shared/runtime-version";
import type {
  RuntimeStatusFact,
  RuntimeStatusItem,
} from "@runweave/shared/runtime-status";
import { copyRuntimeStatusText } from "./copy";

const COMPONENTS = [
  ["backend.process", "Backend"],
  ["backend.cli-version", "CLI（节点 rw）"],
  ["app-server.process", "App Server"],
  ["electron.process", "Desktop"],
  ["feishu.bridge-lease", "飞书 Bridge"],
  ["research-mcp.process", "调查 MCP"],
] as const;

function VersionRow({
  label,
  facts,
  historical = false,
}: {
  label: string;
  facts: RuntimeStatusFact[];
  historical?: boolean;
}) {
  const copy = useMemoizedFn(async () => {
    await copyRuntimeStatusText(
      `${label}\n${facts.map((fact) => `${fact.label}: ${fact.value}`).join("\n")}`,
    );
  });
  const version = facts.find(
    (fact) => fact.id === `${RUNTIME_VERSION_FACT_PREFIX}number`,
  );
  const build = facts.find(
    (fact) => fact.id === `${RUNTIME_VERSION_FACT_PREFIX}build`,
  );
  return (
    <div
      className="min-w-0 border-t border-border/50 py-3 first:border-0"
      data-runtime-version={label}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex min-w-0 items-center gap-1">
          <span className="break-all text-right font-mono text-xs">
            {version?.value ?? "未上报"}
          </span>
          {facts.length > 0 ? (
            <button
              type="button"
              aria-label={`复制 ${label} 版本`}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
              onClick={() => void copy()}
            >
              <Copy className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
      {build ? (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {build.value}
        </p>
      ) : null}
      {historical ? (
        <p className="mt-1 text-xs text-amber-600">
          最近上报，当前状态无法确认
        </p>
      ) : null}
      {facts.length > 1 ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">构建详情</summary>
          <dl className="mt-2 space-y-1">
            {facts
              .filter((fact) => fact !== version && fact !== build)
              .map((fact) => (
                <div key={fact.id}>
                  <dt className="inline">{fact.label}：</dt>
                  <dd className="inline break-all font-mono">{fact.value}</dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

export function RuntimeVersions({ items }: { items: RuntimeStatusItem[] }) {
  return (
    <section
      className="rounded-xl border border-border/70 px-4 py-3"
      aria-label="组件版本"
    >
      <h3 className="text-sm font-medium">组件版本</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        服务上报的运行版本；CLI 为此节点可调用的 rw。
      </p>
      <div className="mt-2">
        {COMPONENTS.filter(
          ([id]) =>
            id !== "electron.process" || items.some((item) => item.id === id),
        ).map(([id, label]) => {
          const item = items.find((entry) => entry.id === id);
          return (
            <VersionRow
              key={id}
              label={label}
              facts={
                item?.facts.filter((fact) =>
                  fact.id.startsWith(RUNTIME_VERSION_FACT_PREFIX),
                ) ?? []
              }
              historical={
                !!item &&
                ["blocked", "unhealthy", "disabled"].includes(item.state)
              }
            />
          );
        })}
      </div>
    </section>
  );
}

const frontendFacts = runtimeVersionFacts(runtimeBuildInfo());
export function FrontendVersion() {
  return (
    <section
      className="rounded-xl border border-border/70 px-4"
      aria-label="当前页面版本"
    >
      <VersionRow label="Web（当前页面）" facts={frontendFacts} />
    </section>
  );
}
