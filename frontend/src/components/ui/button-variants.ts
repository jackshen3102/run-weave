import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-semibold tracking-[-0.01em] transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.985]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_16px_40px_-22px_hsl(var(--primary)/0.8)] hover:-translate-y-0.5 hover:shadow-[0_22px_50px_-24px_hsl(var(--primary)/0.82)]",
        secondary:
          "border border-border/60 bg-muted/78 text-foreground hover:bg-muted",
        ghost: "hover:bg-muted/72",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
