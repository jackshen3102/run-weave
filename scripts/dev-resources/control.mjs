import { inspectResources } from "./snapshot.mjs";
import { releaseResource } from "./operations.mjs";

// Resource cleanup operates on real files, including app.asar archives.
// Electron otherwise exposes archives as virtual directories to fs.rm.
if (process.versions.electron) process.noAsar = true;

async function main() {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8192)
        throw new Error("Control request exceeds size limit");
    }
    const request = JSON.parse(input);
    if (
      typeof request.generation !== "string" ||
      !Number.isInteger(request.backendPid) ||
      request.backendPid <= 1
    )
      throw new Error("Invalid control identity");
    const context = {
      generation: request.generation,
      backendPid: request.backendPid,
    };
    if (request.command !== "inspect" && request.command !== "release")
      throw new Error("Unsupported control action");
    const result =
      request.command === "inspect"
        ? await inspectResources(context)
        : await releaseResource(request, context);
    process.stdout.write(JSON.stringify({ ok: true, value: result }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        status: error.status ?? 200,
        message: error.message,
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
void main();
