import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  invert?: boolean;
}

export function ShimmerText({
  className,
  invert = false,
  ...props
}: ShimmerTextProps) {
  return (
    <span
      className={cn("shimmer", invert && "shimmer-invert", className)}
      {...props}
    />
  );
}
