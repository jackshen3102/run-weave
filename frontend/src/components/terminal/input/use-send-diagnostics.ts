import { useEffect, useRef, type RefObject } from "react";
import { useMemoizedFn } from "ahooks";
import { beginDiagnosticAction } from "../../../lib/action-diagnostics";

/** Keep render evidence separate from transport acknowledgement and target changes. */
export function useSendDiagnostics(draft: string, sending: boolean, scope: RefObject<object | null>) {
  const pending = useRef<{ operation: ReturnType<typeof beginDiagnosticAction>; scope: object | null } | null>(null);
  useEffect(() => {
    if (!draft && !sending && pending.current) {
      pending.current.operation.stage(scope.current === pending.current.scope ? "ui_updated" : "cancelled");
      pending.current = null;
    }
  }, [draft, sending, scope]);
  return useMemoizedFn(() => {
    const operation = beginDiagnosticAction("terminal_send");
    return {
      ...operation,
      reject: () => { operation.stage("rejected"); return false; },
      noop: () => { operation.stage("cancelled"); return true; },
      stateUpdated: (submitted: boolean) => {
        operation.stage("state_updated");
        if (submitted) pending.current = { operation, scope: scope.current };
      },
    };
  });
}
