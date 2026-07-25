import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
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
  const isolatedFrontendDist =
    process.env.RUNWEAVE_ISOLATED_FRONTEND_DIST?.trim();
  if (isolatedFrontendDist) {
    const source = path.resolve(isolatedFrontendDist);
    const sourceStats = lstatSync(source);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error(`Invalid isolated frontend dist: ${source}`);
    }
    const destination = path.join(
      appPath,
      "Contents",
      "Resources",
      "frontend",
      "dist",
    );
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
  }
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
