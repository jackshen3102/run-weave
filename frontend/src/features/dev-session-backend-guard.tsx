import { useEffect, useState, type ReactNode } from "react";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

const DEV_SESSION_ID = import.meta.env.VITE_RUNWEAVE_DEV_SESSION_ID?.trim();
const EXPECTED_BACKEND_ID =
  import.meta.env.VITE_RUNWEAVE_EXPECTED_BACKEND_ID?.trim();
const EXPECTED_BACKEND_PROTOCOL = Number(
  import.meta.env.VITE_RUNWEAVE_EXPECTED_BACKEND_PROTOCOL ?? "0",
);

export function DevSessionBackendGuard({ children }: { children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(!EXPECTED_BACKEND_ID);

  useEffect(() => {
    if (!EXPECTED_BACKEND_ID) {
      return;
    }
    const controller = new AbortController();
    void fetch("/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`health returned HTTP ${response.status}`);
        }
        return (await response.json()) as BackendHealthPayload;
      })
      .then((health) => {
        const identityMatches =
          health.serviceInstanceId === EXPECTED_BACKEND_ID;
        const protocolMatches =
          (health.protocolVersion ?? 0) >= EXPECTED_BACKEND_PROTOCOL;
        if (!identityMatches || !protocolMatches) {
          throw new Error(
            `expected backend ${EXPECTED_BACKEND_ID} protocol>=${EXPECTED_BACKEND_PROTOCOL}; actual ${health.serviceInstanceId ?? "legacy"} protocol=${health.protocolVersion ?? 0}`,
          );
        }
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, []);

  if (failure) {
    return (
      <main
        className="min-h-screen bg-background p-6 text-foreground"
        data-testid="dev-session-backend-mismatch"
      >
        <h1 className="text-lg font-semibold">Dev Session backend mismatch</h1>
        <p className="mt-2 text-sm">Session: {DEV_SESSION_ID ?? "unknown"}</p>
        <p className="mt-1 text-sm">{failure}</p>
      </main>
    );
  }
  if (!ready) {
    return (
      <main
        className="min-h-screen bg-background"
        data-testid="dev-session-backend-checking"
      />
    );
  }
  return children;
}
