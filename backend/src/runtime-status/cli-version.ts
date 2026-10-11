import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeBuildInfo } from "@runweave/shared/runtime-version";

const execute = promisify(execFile);
let cached: { checkedAt: number; value: RuntimeBuildInfo | null } | null = null;
let pending: Promise<RuntimeBuildInfo | null> | null = null;

// Observe the CLI on this Backend's PATH, not a package in its source checkout.
// Version discovery is optional and must never delay/fail the health report.
export async function readNodeCliVersion(): Promise<RuntimeBuildInfo | null> {
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached.value;
  pending ??= (async () => {
    let value: RuntimeBuildInfo | null = null;
    try {
      const { stdout } = await execute("rw", ["version", "--json"], {
        timeout: 1_500,
        maxBuffer: 16_384,
      });
      const info = JSON.parse(stdout);
      const text = (input: unknown): string | undefined =>
        typeof input === "string" && input.length > 0 && input.length <= 256
          ? input
          : undefined;
      const version = text(info.version);
      if (info.name === "@runweave/cli" && version) {
        value = {
          version,
          buildId: text(info.build?.buildId),
          sourceRevision: text(info.build?.sourceRevision),
          builtAt: text(info.build?.builtAt),
          sourceDirty:
            typeof info.build?.sourceDirty === "boolean"
              ? info.build.sourceDirty
              : undefined,
        };
      }
    } catch {
      /* Missing/older CLI does not change service health. */
    }
    cached = { checkedAt: Date.now(), value };
    return value;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
