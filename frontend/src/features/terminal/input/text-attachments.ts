import { HttpError } from "../../../services/http";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import {
  TERMINAL_TEXT_ATTACHMENT_LIMITS as limits,
  type TerminalTextAttachment,
  type TerminalTextAttachmentCapability,
  type TerminalTextAttachmentOperation,
} from "@runweave/shared/terminal/text-attachments";
import {
  terminalTextAttachmentRequest as request,
  terminalTextAttachmentAction as action,
  readTerminalTextAttachment,
} from "../../../services/terminal/sessions";

export interface TextAttachmentItem {
  key: string;
  purpose: "tui" | "composer";
  text: string;
  status:
    | "pending"
    | "saved"
    | "inserted"
    | "not-inserted"
    | "error"
    | "unknown";
  reason?: string;
  attachment?: TerminalTextAttachment;
  operationId: string;
}
type Scope = {
  apiBase: string;
  token: string;
  sessionId: string;
  panelId: string;
  threadId: string | null;
  idle: boolean;
  codex: boolean;
  active: boolean;
};
const scopeKey = (scope: Scope) =>
  JSON.stringify([scope.apiBase, scope.sessionId, scope.panelId]);
// Keep unsent originals while cached terminal surfaces unmount within this page.
const pageRecords = new Map<string, TextAttachmentItem[]>();
// A possible PTY write invalidates the mirror even if its card is dismissed or the scope unmounts.
const unreliableMirrors = new Set<string>();

export function useTerminalTextAttachments(
  scope: Scope,
  onMirrorInvalidated: () => void,
) {
  const current = useRef(scope);

  const generation = useRef(0);
  const lastContext = useRef("");
  const scopeId = scopeKey(scope);
  const context = JSON.stringify([
    scopeId,
    scope.token,
    scope.threadId,
    scope.idle,
    scope.active,
    scope.codex,
  ]);
  if (lastContext.current !== context) {
    lastContext.current = context;
    generation.current++;
  }
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const records = useRef(pageRecords);
  const [, render] = useState(0);
  const [capability, setCapability] = useState<{
    context: string;
    scopeId: string;
    value: TerminalTextAttachmentCapability;
  } | null>(null);
  const update = useMemoizedFn(() => render((value) => value + 1));
  const items = records.current.get(scopeKey(scope)) ?? [];
  const resolvedThreadId =
    scope.threadId ??
    (capability?.scopeId === scopeKey(scope)
      ? capability.value.threadId
      : null);
  const previousThread = useRef(resolvedThreadId);
  if (previousThread.current !== resolvedThreadId) {
    previousThread.current = resolvedThreadId;
    generation.current++;
  }
  current.current = { ...scope, threadId: resolvedThreadId };
  let localConnection = false;
  try {
    const hostname = new URL(
      scope.apiBase || window.location.origin,
      window.location.origin,
    ).hostname;
    localConnection = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      hostname,
    );
  } catch {
    /* Unknown connection ownership keeps native paste. */
  }
  const candidate =
    localConnection &&
    scope.active &&
    scope.idle &&
    scope.codex &&
    Boolean(scope.panelId && resolvedThreadId);
  const enabled =
    candidate &&
    capability?.context === context &&
    capability.value.enabled &&
    capability.value.threadId === resolvedThreadId;

  useEffect(() => {
    let cancelled = false;
    if (!scope.panelId || !scope.idle || !scope.active) return;
    const refresh = () => {
      void request<TerminalTextAttachmentCapability>(
        scope.apiBase,
        scope.token,
        scope.sessionId,
        `/capability?panelId=${encodeURIComponent(scope.panelId)}`,
      )
        .then((value) => {
          if (!cancelled) setCapability({ context, scopeId, value });
        })
        .catch(() => {
          if (!cancelled)
            setCapability({
              context,
              scopeId,
              value: {
                enabled: false,
                provider: null,
                threadId: null,
                executionHost: null,
                reason: "附件能力未确认",
                limits,
              },
            });
        });
    };
    refresh();
    // Runtime attachment and execution evidence can become available after the first render.
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    scope.apiBase,
    scope.token,
    scope.sessionId,
    scope.panelId,
    scope.idle,
    scope.active,
    scope.codex,
    context,
    scopeId,
  ]);

  const markInput = useMemoizedFn((resetMirror = false) => {
    generation.current++;
    if (resetMirror) {
      unreliableMirrors.delete(scopeKey(current.current));
      update();
    }
  });
  const remove = useMemoizedFn((item: TextAttachmentItem) => {
    const key = scopeKey(current.current);
    records.current.set(
      key,
      (records.current.get(key) ?? []).filter((entry) => entry !== item),
    );
    update();
    if (
      item.purpose === "composer" &&
      item.attachment &&
      item.attachment.state === "draft"
    )
      void action(
        current.current.apiBase,
        current.current.token,
        current.current.sessionId,
        item.attachment.id,
        "release",
      ).catch(() => undefined);
  });
  const read = useMemoizedFn(async (item: TextAttachmentItem) => {
    if (!item.attachment) return item.text;
    return readTerminalTextAttachment(
      current.current.apiBase,
      current.current.token,
      current.current.sessionId,
      item.attachment,
    );
  });
  const capture = useMemoizedFn(
    (
      event: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>,
      purpose: "tui" | "composer",
    ): boolean => {
      const clipboard = event.clipboardData;
      if (
        (!enabled && !(candidate && capability?.context !== context)) ||
        !clipboard ||
        Array.from(clipboard.items).some((item) => item.kind === "file")
      )
        return false;
      const text = clipboard.getData("text/plain");
      if (text.length < limits.threshold) return false;
      const bound = { ...current.current };
      const key = scopeKey(bound);
      const startGeneration = generation.current;
      const list = records.current.get(key) ?? [];
      const item: TextAttachmentItem = {
        key: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        text,
        purpose,
        status: "pending",
      };
      records.current.set(key, [...list, item]);
      update();
      event.preventDefault();
      if ("nativeEvent" in event) event.nativeEvent.stopImmediatePropagation();
      else event.stopImmediatePropagation();
      event.stopPropagation();
      if (
        list.filter(
          (entry) => entry.status === "pending" || entry.status === "saved",
        ).length >= limits.maxDraftAttachments
      ) {
        item.status = "error";
        item.reason = "草稿最多保存 20 份附件，原文已保留";
        update();
        return true;
      }
      const present = () => (records.current.get(key) ?? []).includes(item);
      const originalTarget = () =>
        scopeKey(current.current) === key &&
        current.current.threadId === bound.threadId &&
        current.current.idle &&
        current.current.active &&
        generation.current === startGeneration;
      const query = async (operationId: string) =>
        request<TerminalTextAttachmentOperation>(
          bound.apiBase,
          bound.token,
          bound.sessionId,
          `/operations/${encodeURIComponent(operationId)}`,
        );
      void (async () => {
        try {
          // During a fresh scope query, retain the body synchronously instead of leaking it
          // to xterm. Capability denial/failure keeps this recoverable original, never replays it.
          if (!enabled) {
            const verified = await request<TerminalTextAttachmentCapability>(
              bound.apiBase,
              bound.token,
              bound.sessionId,
              `/capability?panelId=${encodeURIComponent(bound.panelId)}`,
            );
            if (!verified.enabled || verified.threadId !== bound.threadId)
              throw new Error(verified.reason ?? "附件能力未确认，原文已保留");
            if (!present() || !originalTarget()) {
              item.status = "not-inserted";
              item.reason = "目标或输入已变化，原文已保留";
              update();
              return;
            }
          }
          let attachment: TerminalTextAttachment;
          try {
            attachment = await request<TerminalTextAttachment>(
              bound.apiBase,
              bound.token,
              bound.sessionId,
              "",
              "POST",
              {
                operationId: item.operationId,
                panelId: bound.panelId,
                expectedThreadId: bound.threadId,
                purpose,
                text,
              },
            );
          } catch (error) {
            // Recovery is read-only. Never repeat the create or fall back to native body input.
            const operation = await query(item.operationId).catch(() => null);
            if (operation?.status !== "saved") throw error;
            attachment = await request<TerminalTextAttachment>(
              bound.apiBase,
              bound.token,
              bound.sessionId,
              `/${operation.attachmentIds[0]}`,
            );
          }
          if (!present() && purpose === "composer") {
            await action(
              bound.apiBase,
              bound.token,
              bound.sessionId,
              attachment.id,
              "release",
            ).catch(() => undefined);
            return;
          }
          item.attachment = attachment;
          item.status = "saved";
          update();
          if (purpose === "composer") return;
          if (!originalTarget()) {
            item.status = "not-inserted";
            item.reason = "目标或输入已变化，未插入路径";
            update();
            return;
          }
          // Until the native draft is cleared/submitted, a pending or uncertain write must not be overwritten.
          unreliableMirrors.add(key);
          onMirrorInvalidated();
          update();
          let operation: TerminalTextAttachmentOperation;
          try {
            operation = await request<TerminalTextAttachmentOperation>(
              bound.apiBase,
              bound.token,
              bound.sessionId,
              `/${attachment.id}/insert`,
              "POST",
              {
                operationId: attachment.insertOperationId,
                panelId: bound.panelId,
                expectedThreadId: bound.threadId,
              },
            );
          } catch (error) {
            if (
              error instanceof HttpError &&
              [400, 409, 410, 413, 507].includes(error.status)
            ) {
              item.status = "not-inserted";
              item.reason = error.message;
              update();
              return;
            }
            const known = await query(attachment.insertOperationId).catch(
              () => null,
            );
            if (!known) {
              item.status = "unknown";
              item.reason = "路径交付未确认，请核对终端";
              update();
              return;
            }
            operation = known;
          }
          item.status =
            operation.status === "accepted"
              ? "inserted"
              : operation.status === "rejected"
                ? "not-inserted"
                : "unknown";
          item.reason = operation.reason;
          if (operation.status !== "rejected") attachment.state = "referenced";
          if (
            operation.status === "accepted" &&
            scopeKey(current.current) === key
          ) {
            generation.current++;
          }
          update();
        } catch (error) {
          if (present()) {
            item.status = "error";
            item.reason =
              error instanceof Error ? error.message : "保存失败，原文已保留";
            update();
          }
        }
      })();
      return true;
    },
  );

  useEffect(() => {
    const renew = () => {
      for (const item of records.current.get(scopeKey(current.current)) ?? []) {
        if (item.attachment?.state === "draft")
          void action(
            current.current.apiBase,
            current.current.token,
            current.current.sessionId,
            item.attachment.id,
            "retain",
          ).catch((error) => {
            item.status = "error";
            item.reason =
              error instanceof Error ? error.message : "附件续期失败";
            update();
          });
      }
    };
    renew();
    const timer = window.setInterval(renew, 24 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [context, update]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        [...records.current.values()].flat().some((item) => !item.attachment)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const composerItems = items.filter((item) => item.purpose === "composer");
  const consume = useMemoizedFn((consumed: TextAttachmentItem[]) => {
    for (const list of records.current.values())
      for (const item of consumed) {
        const index = list.indexOf(item);
        if (index !== -1) list.splice(index, 1);
      }
    update();
  });
  return {
    items,
    enabled,
    capabilityReason: capability?.value.reason ?? null,
    mirrorUnreliable: unreliableMirrors.has(scopeKey(scope)),
    composerItems,
    capture,
    markInput,
    remove,
    read,
    consume,
    blocked: composerItems.some(
      (item) =>
        item.status !== "saved" ||
        item.attachment?.threadId !== resolvedThreadId,
    ),
    ids: composerItems.flatMap((item) =>
      item.attachment ? [item.attachment.id] : [],
    ),
    threadId: resolvedThreadId,
    panelId: scope.panelId,
    scopeId: scopeKey(scope),
  };
}
export type TerminalTextAttachmentsController = ReturnType<
  typeof useTerminalTextAttachments
>;

/** Non-split surfaces do not receive a pane workspace; resolve the actual Backend panel explicitly. */
export function useTextAttachmentWorkspace(options: {
  apiBase: string;
  token: string;
  sessionId: string;
  active: boolean;
  workspace:
    | import("@runweave/shared/terminal/panel").TerminalPanelWorkspace
    | null;
}) {
  const [resolved, setResolved] = useState<{
    key: string;
    workspace: import("@runweave/shared/terminal/panel").TerminalPanelWorkspace;
  } | null>(null);
  const key = JSON.stringify([options.apiBase, options.sessionId]);
  useEffect(() => {
    if (options.workspace || !options.active) return;
    let cancelled = false;
    const refresh = async () => {
      const { listTerminalPanels } =
        await import("../../../services/terminal/panels");
      try {
        const workspace = await listTerminalPanels(
          options.apiBase,
          options.token,
          options.sessionId,
        );
        if (!cancelled) setResolved({ key, workspace });
      } catch {
        if (!cancelled) setResolved(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    key,
    options.apiBase,
    options.sessionId,
    options.token,
    options.active,
    options.workspace,
  ]);
  return (
    options.workspace ?? (resolved?.key === key ? resolved.workspace : null)
  );
}
