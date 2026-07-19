import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CompanionPreferences { version: 1; enabled: boolean }

function preferencePath(): string {
  return path.join(app.getPath("userData"), "desktop-companion.json");
}

export async function readCompanionEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(preferencePath(), "utf8")) as Partial<CompanionPreferences>;
    return parsed.version === 1 && typeof parsed.enabled === "boolean"
      ? parsed.enabled
      : true;
  } catch {
    return true;
  }
}

export async function writeCompanionEnabled(enabled: boolean): Promise<void> {
  const target = preferencePath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify({ version: 1, enabled }), "utf8");
  await rename(temporary, target);
}
