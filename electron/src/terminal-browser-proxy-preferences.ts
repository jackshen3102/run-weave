import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface TerminalBrowserProxyPreferences {
  version: 1;
  enabled: boolean;
}

function preferencePath(): string {
  return path.join(app.getPath("userData"), "terminal-browser-proxy.json");
}

export async function readTerminalBrowserProxyEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(preferencePath(), "utf8"),
    ) as Partial<TerminalBrowserProxyPreferences>;
    return parsed.version === 1 && typeof parsed.enabled === "boolean"
      ? parsed.enabled
      : false;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      console.warn("[electron] failed to read terminal browser proxy preference", {
        path: preferencePath(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

export async function writeTerminalBrowserProxyEnabled(
  enabled: boolean,
): Promise<void> {
  const target = preferencePath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    temporary,
    JSON.stringify({ version: 1, enabled } satisfies TerminalBrowserProxyPreferences),
    "utf8",
  );
  await rename(temporary, target);
}
