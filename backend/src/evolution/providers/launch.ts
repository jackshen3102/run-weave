import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EvolutionProviderName } from "./types";

/** Resolve npm's Windows Codex shim without a shell or an extra wrapper process. */
export function resolveProviderBinary(
  provider: EvolutionProviderName,
  binary: string,
  env: NodeJS.ProcessEnv,
): string {
  if (process.platform !== "win32" || provider !== "codex") return binary;
  const explicitPath = path.isAbsolute(binary) || /[\\/]/.test(binary);
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const candidates = explicitPath
    ? [binary]
    : pathValue.split(path.delimiter).filter(Boolean).flatMap((directory) =>
      path.extname(binary) ? [path.join(directory, binary)]
        : [".exe", ".com", "", ".cmd", ".ps1"].map((suffix) => path.join(directory, binary + suffix)),
    );
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    if (/\.(?:exe|com)$/i.test(candidate)) return candidate;
    if (/^codex(?:\.cmd|\.ps1)?$/i.test(path.basename(candidate))) {
      const native = resolveNpmCodexBinary(path.dirname(candidate));
      if (native) return native;
    }
    // Do not silently select a different installation after finding a wrapper.
    return binary;
  }
  return binary;
}

function resolveNpmCodexBinary(directory: string): string | undefined {
  const packageRoot = path.join(directory, "node_modules", "@openai", "codex");
  const manifestPath = path.join(packageRoot, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
    if (manifest.name !== "@openai/codex") return undefined;
    const target = process.arch === "x64" ? "x86_64-pc-windows-msvc"
      : process.arch === "arm64" ? "aarch64-pc-windows-msvc" : null;
    if (!target) return undefined;
    let platformRoot: string | undefined;
    try {
      platformRoot = path.dirname(createRequire(manifestPath).resolve(`@openai/codex-win32-${process.arch}/package.json`));
    } catch { /* Older Codex packages keep vendor directly inside the main package. */ }
    for (const root of [platformRoot, packageRoot]) {
      if (!root) continue;
      const native = path.join(root, "vendor", target, "bin", "codex.exe");
      if (isFile(native)) return native;
    }
  } catch { /* Preserve the original spawn error for a missing or broken installation. */ }
  return undefined;
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}
