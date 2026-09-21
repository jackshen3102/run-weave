import { logger } from "../logging/index";

/** Deployment policy must not change the identity of existing tmux sockets. */
export function resolveTmuxShutdownPolicy(
  runtimeChannel: "stable" | "beta" | "dev",
): "preserve" | "cleanup" {
  const configured = process.env.TERMINAL_TMUX_SHUTDOWN_POLICY?.trim();
  if (configured && configured !== "preserve" && configured !== "cleanup") {
    throw new Error("TERMINAL_TMUX_SHUTDOWN_POLICY must be preserve or cleanup");
  }
  const policy =
    configured === "preserve" || configured === "cleanup"
      ? configured
      : runtimeChannel === "stable"
        ? "preserve"
        : "cleanup";
  logger.info("terminal.tmux.shutdown-policy", {
    policy,
    source: configured ? "configuration" : "channel-default",
    runtimeChannel,
  });
  return policy;
}
