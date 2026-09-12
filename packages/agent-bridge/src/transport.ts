import { spawn } from "node:child_process";
import path from "node:path";

/** Ordered, bounded delivery shared by native CLI extensions. */
export function createBridgeTransport(source: string, bundledBridge: string) {
  let delivery = Promise.resolve();
  return {
    publish(payload: Record<string, unknown>) {
      const serialized = JSON.stringify(payload);
      delivery = delivery
        .then(
          () =>
            new Promise<void>((resolve) => {
              const override = process.env.RUNWEAVE_AGENT_BRIDGE_ROOT;
              const bridge = override
                ? path.join(override, "runweave-hook-bridge.cjs")
                : bundledBridge;
              const child = spawn(
                process.execPath,
                [bridge, "--source", source],
                {
                  stdio: ["pipe", "ignore", "ignore"],
                },
              );
              const timeout = setTimeout(() => child.kill(), 8000);
              const finish = () => {
                clearTimeout(timeout);
                resolve();
              };
              child.stdin.on("error", () => {});
              child.once("error", finish);
              child.once("close", finish);
              child.stdin.end(serialized);
            }),
        )
        .catch(() => {});
    },
    drain: () => delivery,
  };
}
