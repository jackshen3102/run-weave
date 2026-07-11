import { TerminalRuntimeProvider } from "../../features/terminal/queries/terminal-runtime-provider";
import {
  TerminalWorkspaceContent,
  type TerminalWorkspaceProps,
} from "./terminal-workspace-content";

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
