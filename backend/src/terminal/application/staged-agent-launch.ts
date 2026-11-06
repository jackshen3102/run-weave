import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Keep the queued shell input below the PTY canonical line limit during startup. */
export async function withStagedAgentLaunch(
  command: string,
  submit: (input: string) => Promise<unknown>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "rw-agent-"));
  const file = path.join(directory, "launch.sh");
  const quoted = `'${file.replace(/'/g, "'\\''")}'`;
  try {
    // Source in the existing interactive shell; unlink once opened, before Codex
    // starts. On exit the same shell remains, without rerunning startup files.
    await writeFile(file, `command rm -f -- ${quoted}\n${command}\n`, { mode: 0o600 });
    await submit(`. ${quoted}`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { await access(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Terminal shell did not consume the staged agent command");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
