import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useNavigate } from "react-router-dom";
import type { TaskHandoffEvidence } from "@runweave/shared/task-handoff";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { openHandoffConversation } from "../../../features/terminal/conversation/navigation";
import { Button } from "../../ui/button";

export function HandoffOriginLink({
  origin,
  projectId,
  isCurrent,
  onOpened,
}: {
  origin: NonNullable<TaskHandoffEvidence["origin"]>;
  projectId: string;
  isCurrent?: () => boolean;
  onOpened?: () => void;
}) {
  const runtime = useTerminalRuntime();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const scope = useRef(runtime.scope);
  scope.current = runtime.scope;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const open = useMemoizedFn(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const expectedScope = runtime.scope;
    try {
      await openHandoffConversation({
        origin,
        projectId,
        runtime,
        navigate,
        isCurrent: () =>
          alive.current &&
          expectedScope === scope.current &&
          (isCurrent?.() ?? true),
      });
      onOpened?.();
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "原会话当前不可用");
    } finally {
      if (alive.current) setBusy(false);
    }
  });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="link"
        size="sm"
        disabled={busy}
        onClick={() => void open()}
      >
        {busy
          ? "核对原会话…"
          : origin.messageId
            ? "查看对应回复"
            : "回到原会话"}
      </Button>
      {error ? (
        <p role="status" className="text-xs text-amber-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
