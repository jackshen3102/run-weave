import { Capacitor } from "@capacitor/core";

import { flushSupportLogs } from "./support-log-recorder";
import { redactSupportLogs } from "./support-log-redaction";
import type {
  SupportLogBundle,
  SupportLogScope,
  SupportLogStore,
} from "./support-log-types";

const APP_VERSION = "0.1.0";
const EXPORT_WINDOW_HOURS = 24;

export interface SupportLogExportResult {
  filename: string;
  method: "download" | "share";
  warning?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function createTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function createSupportLogFilename(date = new Date()): string {
  return `runweave-app-support-${createTimestamp(date)}.json`;
}

function serializeBundle(bundle: SupportLogBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export async function buildSupportLogBundle({
  store,
  scope,
}: {
  store: SupportLogStore;
  scope: SupportLogScope;
}): Promise<SupportLogBundle> {
  const createdAt = new Date();
  const since = new Date(
    createdAt.getTime() - EXPORT_WINDOW_HOURS * 60 * 60 * 1000,
  );
  await flushSupportLogs();
  const records = await store.listRecent({ since });
  const { logs, redactionReport } = redactSupportLogs(records);

  return {
    manifest: {
      bundleVersion: 1,
      createdAt: createdAt.toISOString(),
      appVersion: APP_VERSION,
      platform: Capacitor.getPlatform(),
      route: scope.route,
      scope,
      eventCount: logs.length,
    },
    logs,
    redactionReport,
  };
}

export function downloadSupportLogBundle(
  bundle: SupportLogBundle,
  filename = createSupportLogFilename(),
): SupportLogExportResult {
  const blob = new Blob([serializeBundle(bundle)], {
    type: "application/json;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

  return {
    filename,
    method: "download",
  };
}

export async function shareSupportLogBundle(
  bundle: SupportLogBundle,
  filename = createSupportLogFilename(),
): Promise<SupportLogExportResult> {
  if (!Capacitor.isNativePlatform()) {
    return downloadSupportLogBundle(bundle, filename);
  }

  try {
    const [{ Directory, Encoding, Filesystem }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    await Filesystem.writeFile({
      data: serializeBundle(bundle),
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      path: filename,
      recursive: true,
    });
    const uri = await Filesystem.getUri({
      directory: Directory.Cache,
      path: filename,
    });
    await Share.share({
      title: "Runweave App support logs",
      text: "Runweave App diagnostics package",
      url: uri.uri,
      dialogTitle: "Share diagnostics",
    });
    return {
      filename,
      method: "share",
    };
  } catch (error) {
    const result = downloadSupportLogBundle(bundle, filename);
    return {
      ...result,
      warning:
        error instanceof Error
          ? error.message
          : "Native share is unavailable; downloaded diagnostics instead.",
    };
  }
}
