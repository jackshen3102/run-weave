import { useMemoizedFn } from "ahooks";
import { useEffect, useState, type RefObject } from "react";
import { logTerminalPerf } from "../../../features/terminal/output/performance";
import { sendTerminalInput as sendTerminalInputRequest } from "../../../services/terminal/index";
import type {
  TerminalInstantReply,
  TerminalInstantReplyFeedback,
} from "./instant-reply-rail";

interface UseTerminalInstantReplyControllerOptions {
  apiBase: string;
  available: boolean;
  error: string | null;
  onSent: () => void;
  panelId?: string;
  requestScopeRef: RefObject<object | null>;
  sendPendingRef: RefObject<boolean>;
  setSending: (sending: boolean) => void;
  terminalSessionId: string;
  token: string;
}

export function useTerminalInstantReplyController({
  apiBase,
  available,
  error,
  onSent,
  panelId,
  requestScopeRef,
  sendPendingRef,
  setSending,
  terminalSessionId,
  token,
}: UseTerminalInstantReplyControllerOptions) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<TerminalInstantReplyFeedback | null>(
    null,
  );

  useEffect(() => {
    setOpen(false);
    setFeedback(null);
  }, [apiBase, panelId, terminalSessionId]);

  useEffect(() => {
    if (available) {
      return;
    }
    setOpen(false);
    setFeedback(null);
  }, [available]);

  const handleClose = useMemoizedFn(() => {
    setOpen(false);
    setFeedback(null);
  });

  const handleOpen = useMemoizedFn(() => {
    setOpen(true);
  });

  const handleSend = useMemoizedFn(
    async (reply: TerminalInstantReply): Promise<void> => {
      if (sendPendingRef.current || !available) {
        return;
      }
      if (error) {
        setFeedback({
          message: "终端连接不可用，请重连后再发送。",
          tone: "error",
        });
        setOpen(true);
        return;
      }

      const scope = requestScopeRef.current;
      sendPendingRef.current = true;
      setSending(true);
      setFeedback(null);
      try {
        if (!scope || requestScopeRef.current !== scope) {
          return;
        }
        await sendTerminalInputRequest(
          apiBase,
          token,
          terminalSessionId,
          {
            data: reply,
            mode: "prompt_replace",
            submit: true,
            recordQuickInput: false,
            ...(panelId ? { panelId } : {}),
          },
          AbortSignal.timeout(20_000),
        );
        if (requestScopeRef.current !== scope) {
          return;
        }

        onSent();
        setFeedback({
          message: `已发送「${reply}」`,
          tone: "success",
        });
      } catch (requestError) {
        if (requestScopeRef.current !== scope) {
          return;
        }
        logTerminalPerf("terminal.instant_reply.send.failed", {
          terminalSessionId,
          error: String(requestError),
        });
        setFeedback({
          message: "发送结果未确认，请先核对终端结果；不会自动重发。",
          tone: "error",
        });
        setOpen(true);
      } finally {
        if (requestScopeRef.current === scope) {
          sendPendingRef.current = false;
          setSending(false);
        }
      }
    },
  );

  return {
    available,
    feedback,
    onClose: handleClose,
    onOpen: handleOpen,
    onSend: handleSend,
    open,
  };
}
