import { useMemoizedFn } from "ahooks";
import {
  Copy,
  ExternalLink,
  LoaderCircle,
  Play,
  Server,
  Square,
} from "lucide-react";
import { useState } from "react";
import type { WorkspaceServiceSnapshot } from "@runweave/shared/terminal/workspace-service";
import { openTerminalBrowserUrl } from "../../../features/terminal/navigation/open-browser";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import {
  useTerminalWorkspaceQueryClient,
  useTerminalWorkspaceServicesQuery,
} from "../../../features/terminal/queries/workspace";
import { terminalQueryKeys } from "../../../features/terminal/queries/keys";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { cn } from "../../../lib/utils";
import { HttpError } from "../../../services/http";
import {
  startTerminalWorkspaceService,
  stopTerminalWorkspaceService,
} from "../../../services/terminal/index";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";

const CONFIG_EXAMPLE = `{
  "schemaVersion": 1,
  "services": {
    "web": {
      "command": "pnpm dev -- --host 127.0.0.1 --port \\"$RUNWEAVE_SERVICE_PORT\\" --strictPort"
    }
  }
}`;

const STATUS_STYLES: Record<WorkspaceServiceSnapshot["status"], string> = {
  stopped: "bg-slate-500/15 text-slate-400",
  starting: "bg-amber-500/15 text-amber-300",
  ready: "bg-emerald-500/15 text-emerald-300",
  stopping: "bg-amber-500/15 text-amber-300",
  failed: "bg-rose-500/15 text-rose-300",
};

function WorkspaceServiceRow({
  busyAction,
  onOpen,
  onStart,
  onStop,
  service,
}: {
  busyAction: "start" | "stop" | null;
  onOpen: (service: WorkspaceServiceSnapshot) => Promise<void>;
  onStart: (service: WorkspaceServiceSnapshot) => Promise<void>;
  onStop: (service: WorkspaceServiceSnapshot) => Promise<void>;
  service: WorkspaceServiceSnapshot;
}) {
  const [copied, setCopied] = useState(false);
  const handleStart = useMemoizedFn(() => onStart(service));
  const handleStop = useMemoizedFn(() => onStop(service));
  const handleOpen = useMemoizedFn(() => onOpen(service));
  const handleCopy = useMemoizedFn(async (): Promise<void> => {
    await navigator.clipboard.writeText(service.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  });
  const transitioning =
    service.status === "starting" || service.status === "stopping";
  return (
    <div
      className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
      data-testid={`workspace-service-${service.name}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
          {service.name}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            STATUS_STYLES[service.status],
          )}
        >
          {transitioning ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : null}
          {service.status}
        </span>
      </div>
      <div className="rounded-md bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-4 text-slate-400">
        <div className="text-slate-500">cwd: {service.cwd}</div>
        <div className="break-all text-slate-300">{service.command}</div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={
            busyAction !== null ||
            service.status === "starting" ||
            service.status === "ready" ||
            service.status === "stopping"
          }
          onClick={handleStart}
        >
          <Play className="h-3 w-3" /> Start
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={
            busyAction !== null ||
            (service.status !== "starting" && service.status !== "ready")
          }
          onClick={handleStop}
        >
          <Square className="h-3 w-3" /> Stop
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={service.status !== "ready"}
          onClick={handleOpen}
        >
          <ExternalLink className="h-3 w-3" /> Open
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-[11px]"
          aria-label={`Copy ${service.name} URL`}
          title={service.url}
          onClick={handleCopy}
        >
          <Copy className="h-3 w-3" /> {copied ? "Copied" : "URL"}
        </Button>
      </div>
      <div className="break-all text-[10px] text-slate-500">{service.url}</div>
      {service.staleConfig ? (
        <div className="text-xs text-amber-300">
          Config changed · restart required
        </div>
      ) : null}
      {service.error ? (
        <div className="text-xs text-rose-300">{service.error.message}</div>
      ) : null}
    </div>
  );
}

export function TerminalWorkspaceServicesPopover({
  contextAvailable,
  disabled,
  parentProjectId,
  projectId,
}: {
  contextAvailable: boolean;
  disabled?: boolean;
  parentProjectId: string | null;
  projectId: string | null;
}) {
  const { apiBase, scope, token } = useTerminalRuntime();
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const query = useTerminalWorkspaceServicesQuery(
    parentProjectId,
    projectId,
    contextAvailable,
  );
  const [busy, setBusy] = useState<{
    action: "start" | "stop";
    name: string;
  } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const data = contextAvailable ? query.data : undefined;
  const services = data?.services ?? [];
  const readyCount = services.filter((service) => service.status === "ready").length;
  const hasError =
    contextAvailable &&
    (Boolean(query.error) ||
      data?.config.status === "invalid" ||
      services.some((service) => service.status === "failed"));

  const invalidate = useMemoizedFn(async (): Promise<void> => {
    if (!parentProjectId || !projectId) return;
    await queryClient.invalidateQueries({
      queryKey: terminalQueryKeys.workspaceServices(
        scope,
        parentProjectId,
        projectId,
      ),
    });
  });
  const handleStart = useMemoizedFn(
    async (service: WorkspaceServiceSnapshot): Promise<void> => {
      if (!parentProjectId || !projectId || !data?.config.revision) return;
      setBusy({ action: "start", name: service.name });
      setMutationError(null);
      try {
        await startTerminalWorkspaceService(
          apiBase,
          token,
          parentProjectId,
          projectId,
          service.name,
          data.config.revision,
        );
        await invalidate();
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
  );
  const handleStop = useMemoizedFn(
    async (service: WorkspaceServiceSnapshot): Promise<void> => {
      if (!parentProjectId || !projectId) return;
      setBusy({ action: "stop", name: service.name });
      setMutationError(null);
      try {
        await stopTerminalWorkspaceService(
          apiBase,
          token,
          parentProjectId,
          projectId,
          service.name,
        );
        await invalidate();
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
  );
  const handleOpen = useMemoizedFn(
    async (service: WorkspaceServiceSnapshot): Promise<void> => {
      if (!projectId) return;
      setMutationError(null);
      try {
        const profileId = await openTerminalBrowserUrl({
          url: service.url,
          projectId,
          placement: { kind: "new-group" },
        });
        if (profileId) {
          useTerminalPreviewStore.getState().activateBrowser(profileId, null);
        }
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  const localOnlyError =
    contextAvailable &&
    query.error instanceof HttpError &&
    query.error.status === 403;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !parentProjectId || !projectId}
          className="relative h-6 shrink-0 rounded-md px-2 text-[11px] text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          data-testid="workspace-services-trigger"
        >
          <Server className="h-3.5 w-3.5" />
          Services
          <span className="text-slate-500">
            {!contextAvailable
              ? "—"
              : query.isPending
                ? "…"
                : `${readyCount}/${services.length}`}
          </span>
          {hasError ? (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-rose-400" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2 p-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">
            Workspace Services
          </div>
          <div className="text-[11px] text-slate-500">
            Current Project Context · explicit start only
          </div>
        </div>
        {!contextAvailable ? (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
            Set a Project path to use Workspace Services.
          </div>
        ) : null}
        {contextAvailable && query.isPending ? (
          <div className="py-6 text-center text-xs text-slate-500">
            Reading runweave.json…
          </div>
        ) : null}
        {localOnlyError ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            Workspace Services are available only from this computer.
          </div>
        ) : contextAvailable && query.error ? (
          <div className="text-xs text-rose-300">{query.error.message}</div>
        ) : null}
        {data?.config.status === "missing" ? (
          <div className="space-y-2 text-xs text-slate-400">
            <p>Add a repository-root runweave.json to declare local services.</p>
            <pre className="overflow-x-auto rounded-lg bg-black/30 p-2 text-[10px] leading-4 text-slate-300">
              {CONFIG_EXAMPLE}
            </pre>
            <a
              className="text-indigo-300 hover:text-indigo-200"
              href="https://github.com/jackshen3102/run-weave/blob/main/docs/architecture/terminal-workspace-services.md"
              target="_blank"
              rel="noreferrer"
            >
              Configuration and security boundary
            </a>
          </div>
        ) : null}
        {data?.config.status === "invalid" ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            {data.config.error?.message ?? "runweave.json is invalid"}
          </div>
        ) : null}
        {services.map((service) => (
          <WorkspaceServiceRow
            key={service.name}
            service={service}
            busyAction={busy?.name === service.name ? busy.action : null}
            onStart={handleStart}
            onStop={handleStop}
            onOpen={handleOpen}
          />
        ))}
        {mutationError ? (
          <div className="text-xs text-rose-300">{mutationError}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
