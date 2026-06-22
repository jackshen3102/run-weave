import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export default async function adhocSignMac(context) {
  if (
    process.platform !== "darwin" ||
    context.electronPlatformName !== "darwin"
  ) {
    return;
  }

  const appName = readdirSync(context.appOutDir).find((entry) =>
    entry.endsWith(".app"),
  );
  if (!appName) {
    throw new Error(`No .app bundle found in ${context.appOutDir}`);
  }

  const appPath = path.join(context.appOutDir, appName);
  for (const arch of ["arm64", "x64"]) {
    const spawnHelperPath = path.join(
      appPath,
      "Contents",
      "Resources",
      "backend",
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${arch}`,
      "spawn-helper",
    );
    if (existsSync(spawnHelperPath)) {
      chmodSync(spawnHelperPath, 0o755);
    }
  }
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
  const identity = process.env.RUNWEAVE_CODESIGN_IDENTITY?.trim() || "-";
  execFileSync("codesign", ["--force", "--deep", "--sign", identity, appPath], {
    stdio: "inherit",
  });
}
