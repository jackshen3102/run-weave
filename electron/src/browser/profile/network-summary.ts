import { readFileSync } from "node:fs";
import path from "node:path";
import type { DesktopProxySummary } from "@runweave/shared/tunnels";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { desktopStateRoot } from "../../desktop/local-state.js";
import { getTerminalBrowserProfileRuntimeStates } from "./runtime.js";

const metadata = new Map<
  TerminalBrowserProfileId,
  { hasRules: boolean | null; rulesObservedAt: number | null }
>();
const pending = new Set<TerminalBrowserProfileId>();
let initialized = false;
export function desktopProxySummaries(): DesktopProxySummary[] {
  if (!initialized) {
    initialized = true;
    try {
      const previous = JSON.parse(
        readFileSync(
          path.join(desktopStateRoot(), "desktop-network.json"),
          "utf8",
        ),
      ) as { proxyProfiles: DesktopProxySummary[] };
      for (const p of previous.proxyProfiles ?? [])
        if (
          typeof p.hasRules === "boolean" &&
          typeof p.rulesObservedAt === "number"
        )
          metadata.set(p.profileId, {
            hasRules: p.hasRules,
            rulesObservedAt: p.rulesObservedAt,
          });
    } catch {
      /* First run has no rule metadata. */
    }
  }
  return getTerminalBrowserProfileRuntimeStates().map((profile) => {
    const observed = metadata.get(profile.profileId) ?? {
      hasRules: null,
      rulesObservedAt: null,
    };
    if (
      profile.whistle.status === "ready" &&
      !pending.has(profile.profileId) &&
      Date.now() - (observed.rulesObservedAt ?? 0) > 10000
    ) {
      pending.add(profile.profileId);
      void fetch(
        `http://127.0.0.1:${profile.whistle.port}/cgi-bin/rules/list`,
        { signal: AbortSignal.timeout(2000), redirect: "error" },
      )
        .then(async (response) => {
          if (!response.ok) return;
          const rules = (await response.json()) as {
            defaultRules?: unknown;
            list?: Array<{ data?: unknown }>;
          };
          const hasRules =
            (typeof rules.defaultRules === "string" &&
              !!rules.defaultRules.trim()) ||
            !!rules.list?.some(
              (rule) => typeof rule.data === "string" && !!rule.data.trim(),
            );
          metadata.set(profile.profileId, {
            hasRules,
            rulesObservedAt: Date.now(),
          });
        })
        .catch(() => {})
        .finally(() => pending.delete(profile.profileId));
    }
    return { ...profile, ...observed };
  });
}
