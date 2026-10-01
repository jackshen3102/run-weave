import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function buildResourceSampler(
  directory = path.join(root, ".native-artifacts"),
) {
  if (process.platform !== "darwin") return;
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, "resource-sampler");
  for (const [command, args] of [
    [
      "/usr/bin/xcrun",
      [
        "clang",
        "-O2",
        "-Wall",
        "-Werror",
        "-mmacosx-version-min=12.0",
        path.join(root, "native/resource-sampler.c"),
        "-o",
        output,
      ],
    ],
    ["/usr/bin/codesign", ["--force", "--sign", "-", output]],
  ]) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0)
      throw new Error("Backend resource sampler build failed");
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  buildResourceSampler();
