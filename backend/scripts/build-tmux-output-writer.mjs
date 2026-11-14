import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function buildTmuxOutputWriter(directory = path.join(root, ".native-artifacts")) {
  if (process.platform === "win32") return;
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, "tmux-output-writer");
  const darwin = process.platform === "darwin";
  const commands = [[darwin ? "/usr/bin/xcrun" : "cc", [
    ...(darwin ? ["clang", "-mmacosx-version-min=12.0"] : []),
    "-O2", "-Wall", "-Wextra", "-Werror",
    path.join(root, "native/tmux-output-writer.c"), "-o", output,
  ]]];
  if (darwin) commands.push(["/usr/bin/codesign", ["--force", "--sign", "-", output]]);
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Backend tmux output writer build failed");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTmuxOutputWriter();
}
