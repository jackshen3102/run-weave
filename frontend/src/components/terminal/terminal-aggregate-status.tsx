import type { CSSProperties } from "react";
import {
  TERMINAL_AGGREGATE_HAS_BELL,
  TERMINAL_AGGREGATE_HAS_COMPLETION,
  TERMINAL_AGGREGATE_IS_WORKING,
} from "../../features/terminal/workspace-store";
import { ShimmerText } from "../ui/shimmer-text";

interface TerminalAggregateStatusProps {
  label: string;
  status: number;
  className?: string;
  labelClassName?: string;
}

export function TerminalAggregateStatus({
  label,
  status,
  className,
  labelClassName,
}: TerminalAggregateStatusProps) {
  const isWorking = Boolean(status & TERMINAL_AGGREGATE_IS_WORKING);
  const eventStatus =
    status & TERMINAL_AGGREGATE_HAS_BELL
      ? "bell"
      : status & TERMINAL_AGGREGATE_HAS_COMPLETION
        ? "completion"
        : "none";

  return (
    <span
      className={["inline-flex min-w-0 items-center gap-2", className]
        .filter(Boolean)
        .join(" ")}
    >
      {isWorking ? (
        <ShimmerText
          className={["shimmer-invert", labelClassName]
            .filter(Boolean)
            .join(" ")}
          style={
            {
              "--shimmer-duration": "4000",
              "--shimmer-repeat-delay": "300",
            } as CSSProperties
          }
        >
          {label}
        </ShimmerText>
      ) : (
        <span className={labelClassName}>{label}</span>
      )}
      <span
        aria-hidden="true"
        data-terminal-event-status={eventStatus}
        className={[
          "h-1.5 w-1.5 shrink-0 rounded-full",
          eventStatus === "bell"
            ? "bg-amber-400"
            : eventStatus === "completion"
              ? "bg-emerald-400"
              : "bg-transparent",
        ].join(" ")}
      />
    </span>
  );
}
