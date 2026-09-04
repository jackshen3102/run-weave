import { TerminalRuntimeProvider } from "../../../features/terminal/queries/provider";
import { TerminalWorkspaceContent } from "./content";
import type { TerminalWorkspaceProps } from "./types";

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
