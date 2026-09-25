import {
  getTerminalBrowserProfileConfig,
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { isBetaChannel, isManagedDevSession } from "../../desktop/config.js";
let ports: number[] | null = null;
export function getProfileWhistlePorts(): number[] {
  if (ports) return [...ports];
  const raw = process.env.RUNWEAVE_WHISTLE_PORTS;
  const selected =
    raw?.split(",").map(Number) ??
    (isManagedDevSession || isBetaChannel ? [] : [8081, 8082, 8083]);
  if (
    selected.length !== 3 ||
    new Set(selected).size !== 3 ||
    selected.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535) ||
    ((isManagedDevSession || isBetaChannel) &&
      selected.some((p) => [8081, 8082, 8083].includes(p)))
  )
    throw new Error("ISOLATED_WHISTLE_PORTS_REQUIRED");
  ports = selected;
  return [...ports];
}
export function getRuntimeBrowserProfileConfig(
  profileId: TerminalBrowserProfileId,
) {
  return {
    ...getTerminalBrowserProfileConfig(profileId),
    whistlePort:
      getProfileWhistlePorts()[
        TERMINAL_BROWSER_PROFILE_IDS.indexOf(profileId)
      ]!,
  };
}
