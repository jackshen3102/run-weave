import { TerminalRuntimeProvider } from "../../features/terminal/queries/terminal-runtime-provider";
import { TerminalWorkspaceContent } from "./terminal-workspace-content";
import type { TerminalWorkspaceProps } from "./terminal-workspace-types";

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  return (
    <TerminalRuntimeProvider
      activeConnectionId={props.connection?.activeConnectionId}
      apiBase={props.apiBase}
      onAuthExpired={props.onAuthExpired}
      token={props.token}
    >
      <TerminalWorkspaceContent {...props} />
    </TerminalRuntimeProvider>
  );
}
