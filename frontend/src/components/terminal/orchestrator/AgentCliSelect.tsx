import type { AgentCliCommand } from "./types";
import { AGENT_CLI_OPTIONS } from "./constants";
import { normalizeAgentCliCommand } from "./utils";

export function AgentCliSelect(props: {
  value: AgentCliCommand;
  onChange: (value: AgentCliCommand) => void;
}) {
  return (
    <select
      value={props.value}
      onChange={(event) =>
        props.onChange(normalizeAgentCliCommand(event.target.value))
      }
      className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
    >
      {AGENT_CLI_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
