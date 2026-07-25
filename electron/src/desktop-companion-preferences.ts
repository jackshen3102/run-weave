import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CompanionPreferences { version: 1; enabled: boolean }

function preferencePath(): string {
  return path.join(app.getPath("userData"), "desktop-companion.json");
}

// Dev Session 下默认隐藏桌面宠物：开发时基本用不到，也避免干扰正式版宠物。
// 仍可从托盘开关手动开启（例如需要开发/联调宠物本身），开启后会持久化到该实例。
function defaultCompanionEnabled(): boolean {
  return !process.env.RUNWEAVE_DEV_SESSION_ID?.trim();
}

export async function readCompanionEnabled(): Promise<boolean> {
  const fallback = defaultCompanionEnabled();
  try {
    const parsed = JSON.parse(await readFile(preferencePath(), "utf8")) as Partial<CompanionPreferences>;
    return parsed.version === 1 && typeof parsed.enabled === "boolean"
      ? parsed.enabled
      : fallback;
  } catch {
    return fallback;
  }
}

export async function writeCompanionEnabled(enabled: boolean): Promise<void> {
  const target = preferencePath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify({ version: 1, enabled }), "utf8");
  await rename(temporary, target);
}
