import type { InferredWorkloadState } from "./terminal-state";

export type MobileTerminalFilter = "all" | "attention" | "other";

const FILTERS: Array<{
  value: MobileTerminalFilter;
  label: string;
}> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需要处理" },
  { value: "other", label: "其它" },
];

const ATTENTION_STATES: InferredWorkloadState[] = [
  "agent_waiting_input",
  "failed",
  "possibly_stuck",
];

interface TerminalStatusFilterProps {
  value: MobileTerminalFilter;
  onChange: (value: MobileTerminalFilter) => void;
}

export function matchesMobileTerminalFilter(
  state: InferredWorkloadState,
  filter: MobileTerminalFilter,
): boolean {
  if (filter === "all") {
    return true;
  }

  const needsAttention = ATTENTION_STATES.includes(state);
  return filter === "attention" ? needsAttention : !needsAttention;
}

export function TerminalStatusFilter({
  value,
  onChange,
}: TerminalStatusFilterProps) {
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2">
      {FILTERS.map((filter) => {
        const isActive = filter.value === value;
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={isActive}
            className={[
              "h-8 shrink-0 rounded-full border px-3 text-xs font-medium shadow-sm transition-colors",
              isActive
                ? "border-foreground bg-foreground text-background"
                : "border-border/60 bg-card/72 text-muted-foreground hover:border-border hover:text-foreground",
            ].join(" ")}
            onClick={() => {
              onChange(filter.value);
            }}
          >
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}
