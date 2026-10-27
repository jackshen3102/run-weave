import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { BrowserHistoryOutbox } from "@runweave/browser-history/outbox";
import {
  historyUuid,
  type BrowserHistoryStatus,
  type BrowserVisitObservation,
} from "@runweave/shared/browser-history";
import {
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import {
  desktopStateRoot,
  writePrivateJson,
} from "../../../../desktop/local-state.js";
import { isManagedDevSession } from "../../../../desktop/config.js";
type Preference = { sourceId: string; enabled: boolean };
let preferences: Record<TerminalBrowserProfileId, Preference> | undefined;
const writers = new Map<TerminalBrowserProfileId, BrowserHistoryOutbox>();
const stagingErrors = new Map<TerminalBrowserProfileId, string>();
let retryTimer: ReturnType<typeof setInterval> | undefined;
let preferenceError: string | null = null;
const configFile = () =>
  path.join(desktopStateRoot(), "browser-history-source.json");
export const browserHistoryRoot = () =>
  isManagedDevSession
    ? path.join(app.getPath("userData"), "browser-history")
    : path.join(os.homedir(), ".runweave/browser-history");
function prefs() {
  if (preferences) return preferences;
  try {
    const value = JSON.parse(readFileSync(configFile(), "utf8"));
    if (
      value.schemaVersion !== 1 ||
      !TERMINAL_BROWSER_PROFILE_IDS.every(
        (p) =>
          historyUuid(value.profiles?.[p]?.sourceId) &&
          typeof value.profiles[p].enabled === "boolean",
      )
    )
      throw Error("INVALID_HISTORY_PREFERENCES");
    preferences = value.profiles;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      preferenceError = "浏览记录配置不可读，已停止采集；原文件保留。";
      throw e;
    }
    const initial = Object.fromEntries(
      TERMINAL_BROWSER_PROFILE_IDS.map((p) => [
        p,
        { sourceId: randomUUID(), enabled: false },
      ]),
    ) as Record<TerminalBrowserProfileId, Preference>;
    writePrivateJson(configFile(), { schemaVersion: 1, profiles: initial });
    preferences = initial;
  }
  return preferences!;
}
export function getBrowserHistoryStatus(
  profile: TerminalBrowserProfileId,
): BrowserHistoryStatus {
  try {
    const pref = prefs()[profile];
    return {
      ...pref,
      enabled: pref.enabled && !stagingErrors.has(profile),
      root: browserHistoryRoot(),
      pending: writers.get(profile)?.pending ?? 0,
      lastStoredAt: writers.get(profile)?.lastStoredAt ?? null,
      error:
        preferenceError ??
        stagingErrors.get(profile) ??
        writers.get(profile)?.error ??
        null,
    };
  } catch {
    return {
      enabled: false,
      sourceId: "",
      root: browserHistoryRoot(),
      pending: 0,
      lastStoredAt: null,
      error: preferenceError ?? "无法读取浏览记录配置",
    };
  }
}
export function setBrowserHistoryRecording(
  profile: TerminalBrowserProfileId,
  enabled: boolean,
) {
  const next = structuredClone(prefs());
  next[profile].enabled = enabled;
  writePrivateJson(configFile(), { schemaVersion: 1, profiles: next });
  preferences = next;
  stagingErrors.delete(profile);
  if (enabled) {
    void getWriter(profile).flush();
  }
  return getBrowserHistoryStatus(profile);
}
function getWriter(profile: TerminalBrowserProfileId) {
  let writer = writers.get(profile);
  if (!writer) {
    writer = new BrowserHistoryOutbox(
      browserHistoryRoot(),
      path.join(desktopStateRoot(), "browser-history-outbox", profile),
      {
        sourceId: prefs()[profile].sourceId,
        browser: "runweave",
        profileLabel: profile,
      },
    );
    writers.set(profile, writer);
  }
  return writer;
}
export function recordBrowserHistory(
  profile: TerminalBrowserProfileId,
  visit: BrowserVisitObservation,
) {
  try {
    getWriter(profile).enqueue(visit);
  } catch (e) {
    stagingErrors.set(profile, `采集已暂停，待保存文件写入异常：${String(e)}`);
  }
}
export async function retryBrowserHistory(profile: TerminalBrowserProfileId) {
  await getWriter(profile).flush();
}
export async function startBrowserHistory() {
  for (const profile of TERMINAL_BROWSER_PROFILE_IDS) {
    try {
      await getWriter(profile).flush();
    } catch (e) {
      stagingErrors.set(profile, String(e));
    }
  }
  retryTimer = setInterval(() => {
    for (const writer of writers.values())
      if (writer.pending) void writer.flush();
  }, 30_000);
  retryTimer.unref();
}
export async function closeBrowserHistory() {
  clearInterval(retryTimer);
  await Promise.allSettled(
    [...writers.values()].map((writer) => writer.close()),
  );
}
