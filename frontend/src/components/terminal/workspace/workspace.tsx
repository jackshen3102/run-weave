import { TerminalRuntimeProvider } from "../../../features/terminal/queries/provider";
import { TerminalWorkspaceContent } from "./content";
import type { TerminalWorkspaceProps } from "./types";
import { useLayoutEffect } from "react";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  useLayoutEffect(() => {
    useTerminalPreviewStore.getState().setConnectionScope(
      props.connection?.activeConnectionId ?? "web",
    );
  }, [props.connection?.activeConnectionId]);
  return (
    <TerminalRuntimeProvider
      activeConnectionId={props.connection?.activeConnectionId}
      apiBase={props.apiBase}
      onAuthExpired={props.onAuthExpired}
      token={props.token}
      remote={props.connection?.remote}
    >
      <TerminalWorkspaceContent {...props} />
    </TerminalRuntimeProvider>
  );
}
