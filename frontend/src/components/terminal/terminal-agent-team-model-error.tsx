import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import type { AgentTeamModelErrorDetails } from "@runweave/shared/agent-team-model-config";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { HttpError } from "../../services/http";

export function useAgentTeamModelConfigError(onAuthExpired?: () => void) {
  const [message, setErrorMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<AgentTeamModelErrorDetails | null>(
    null,
  );

  return {
    message,
    details,
    setMessage: useMemoizedFn((next: string | null) => {
      setErrorMessage(next);
      setDetails(null);
    }),
    handle: useMemoizedFn((caught: unknown): void => {
      if (caught instanceof HttpError && caught.status === 401) {
        onAuthExpired?.();
        return;
      }
      setErrorMessage(
        caught instanceof Error ? caught.message : String(caught),
      );
      setDetails(
        caught instanceof HttpError &&
          isAgentTeamModelConfigError(caught.details)
          ? caught.details
          : null,
      );
    }),
    clear: useMemoizedFn(() => {
      setErrorMessage(null);
      setDetails(null);
    }),
  };
}

export function AgentTeamModelErrorNotice({
  message,
  details,
}: {
  message: string | null;
  details: AgentTeamModelErrorDetails | null;
}) {
  const setAgentTeamModelConfigOpen = useTerminalWorkspaceStore(
    (state) => state.setAgentTeamModelConfigOpen,
  );
  if (!message) {
    return null;
  }
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded border border-rose-800 bg-rose-950/50 px-2 py-1 text-[11px] text-rose-300">
      <span className="min-w-0 flex-1">{message}</span>
      {details ? (
        <button
          type="button"
          className="shrink-0 rounded border border-rose-500/40 px-2 py-1 text-rose-200 hover:bg-rose-900/50"
          onClick={() => setAgentTeamModelConfigOpen(true)}
        >
          去配置
        </button>
      ) : null}
    </div>
  );
}

function isAgentTeamModelConfigError(
  details: unknown,
): details is AgentTeamModelErrorDetails {
  if (typeof details !== "object" || details === null || !("code" in details)) {
    return false;
  }
  return [
    "config_required",
    "provider_unavailable",
    "model_unavailable",
    "parameter_unsupported",
  ].includes(String(details.code));
}
