import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import type {
  AttachmentState,
  OpenScheduledRunResponse,
} from "@runweave/shared/scheduled-tasks";
import { HttpError } from "../../services/http";
import { terminalQueryKeys } from "../terminal/queries/keys";
import { setTerminalNavigation } from "../terminal/state/navigation";
import { useScheduledApi, scheduledKeys } from "./queries";

export function useOpenRun() {
  const { api, scope } = useScheduledApi();
  const client = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  const [attachmentState, setAttachmentState] =
    useState<AttachmentState | null>(null);
  const cancellation = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancellation.current?.abort();
    };
  }, []);
  const mutation = useMutation({
    mutationFn: async (runId: string) => {
      cancellation.current = new AbortController();
      const signal = cancellation.current.signal;
      setAttachmentState(null);
      let result: OpenScheduledRunResponse;
      try {
        result = await api.open(runId);
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.code === "terminal_repurposed" &&
          mounted.current &&
          window.confirm("原终端已用于另一个对话。是否为本次运行另开终端？")
        ) {
          result = await api.open(runId, { replaceRepurposedBinding: true });
        } else {
          throw error;
        }
      }
      signal.throwIfAborted();
      setAttachmentState(result.attachmentState);
      const deadline = Date.now() + 90_000;
      while (result.attachmentState !== "ready") {
        if (result.attachmentState === "failed")
          throw new Error(result.error ?? "对话恢复失败，请重试。");
        if (Date.now() >= deadline)
          throw new Error("对话尚未确认恢复，请稍后重试打开同一记录。");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("页面已离开", "AbortError"));
          };
          const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 3_000);
          signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        if (document.visibilityState !== "visible" || !navigator.onLine)
          continue;
        const current = await api.run(runId, signal);
        const binding = current.terminalBinding;
        if (
          !binding ||
          binding.terminalSessionId !== result.terminalSessionId ||
          binding.panelId !== result.panelId
        ) {
          throw new Error("终端绑定已变化，请重新打开运行记录。");
        }
        result = { ...result, ...binding };
        setAttachmentState(binding.attachmentState);
      }
      return result;
    },
    onSuccess: async (result) => {
      await Promise.all([
        client
          .invalidateQueries({ queryKey: terminalQueryKeys.all(scope) })
          .then(() =>
            // The terminal list is inactive while this page is open.
            client.refetchQueries(
              {
                queryKey: terminalQueryKeys.sessions(scope),
                exact: true,
                type: "all",
              },
              { throwOnError: true },
            ),
          ),
        client.invalidateQueries({ queryKey: scheduledKeys.all(scope) }),
      ]);
      if (!mounted.current) return;
      if (result.attachmentState === "failed")
        throw new Error(result.error ?? "对话恢复失败，请重试。");
      setTerminalNavigation(scope, {
        parentProjectId: resolveTerminalParentProjectId(result.projectId),
        projectId: result.projectId,
        terminalSessionId: result.terminalSessionId,
        panelId: result.panelId,
      });
      // Build the existing internal route from the returned identity; never follow an arbitrary URL.
      navigate(`/terminal/${encodeURIComponent(result.terminalSessionId)}`);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: scheduledKeys.all(scope) });
    },
  });
  return { ...mutation, attachmentState };
}
