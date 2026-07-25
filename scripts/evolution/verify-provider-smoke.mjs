import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexEvolutionProvider } from "../../backend/src/evolution/providers/codex.ts";
import { TraeEvolutionProvider } from "../../backend/src/evolution/providers/trae.ts";

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "ok"],
  properties: {
    provider: { type: "string", enum: ["codex", "trae"] },
    ok: { type: "boolean", const: true },
  },
};

async function runSmoke(provider) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `runweave-evolution-${provider.provider}-`),
  );
  try {
    const workingDirectory = path.join(root, "working");
    await mkdir(workingDirectory, { mode: 0o700 });
    const outputSchemaPath = path.join(root, "output-schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(outputSchema), {
      mode: 0o600,
    });
    const result = await provider.run({
      prompt: [
        "Return the requested JSON object.",
        `Set provider to ${provider.provider} and ok to true.`,
        "Do not call tools.",
      ].join("\n"),
      workingDirectory,
      outputSchemaPath,
      maxWallTimeMs: 2 * 60_000,
      maxOutputBytes: 256_000,
    });
    assert.deepEqual(result.output, {
      provider: provider.provider,
      ok: true,
    });
    return {
      provider: provider.provider,
      durationMs: result.durationMs,
      eventCount: result.events.length,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = await Promise.all([
  runSmoke(new CodexEvolutionProvider()),
  runSmoke(new TraeEvolutionProvider()),
]);
process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
