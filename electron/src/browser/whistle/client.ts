import {
  TERMINAL_BROWSER_RESERVED_WHISTLE_VALUE,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "../errors.js";

const REQUEST_TIMEOUT_MS = 2_000;

async function requestWhistle(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await requestWhistle(port, pathname, init);
  if (!response.ok) {
    throw new Error(`Whistle returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getWhistleStatus(
  port: number,
): Promise<{ storage: string; version: string }> {
  return await readJson(port, "/cgi-bin/status");
}

export async function getWhistleReservedValue(
  port: number,
): Promise<string | null> {
  const result = await readJson<{ value?: unknown }>(
    port,
    `/cgi-bin/values/value?key=${encodeURIComponent(
      TERMINAL_BROWSER_RESERVED_WHISTLE_VALUE,
    )}`,
  );
  return typeof result.value === "string" ? result.value : null;
}

export async function setWhistleReservedValue(
  profileId: TerminalBrowserProfileId,
  port: number,
  value: string | null,
): Promise<void> {
  try {
    const body = new URLSearchParams({
      name: TERMINAL_BROWSER_RESERVED_WHISTLE_VALUE,
    });
    if (value === null) {
      await readJson(port, "/cgi-bin/values/remove", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } else {
      body.set("value", value);
      await readJson(port, "/cgi-bin/values/add", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    }
    const actual = await getWhistleReservedValue(port);
    if (actual !== value) {
      throw new Error(
        `read-back mismatch: expected ${value}, received ${actual}`,
      );
    }
  } catch (error) {
    throw new TerminalBrowserError(
      "WHISTLE_VALUE_UPDATE_FAILED",
      `Failed to update the reserved Whistle Value for ${profileId}`,
      {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function getWhistleRootCa(port: number): Promise<string> {
  const response = await requestWhistle(port, "/cgi-bin/rootca?type=pem");
  if (!response.ok) {
    throw new Error(`Whistle returned HTTP ${response.status}`);
  }
  return await response.text();
}
