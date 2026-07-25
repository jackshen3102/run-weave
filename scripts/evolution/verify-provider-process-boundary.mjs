import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexEvolutionProvider } from "../../backend/src/evolution/providers/codex.ts";
import { TraeEvolutionProvider } from "../../backend/src/evolution/providers/trae.ts";

export async function verifyProviderProcessBoundary(tempRoot) {
  const providerRoot = path.join(tempRoot, "provider");
  const fakeProviderPath = path.join(providerRoot, "fake-provider.mjs");
  const schemaPath = path.join(providerRoot, "output-schema.json");
  await mkdir(providerRoot, { recursive: true });
  await writeFile(
    fakeProviderPath,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
for (const required of ["--ask-for-approval", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--json", "--output-schema", "--output-last-message"]) {
  if (!args.includes(required)) process.exit(21);
}
if (args.some((arg) => arg.includes("mcp_servers.runweave-evolution.url"))) {
  if (!args.some((arg) => arg.includes("mcp_servers.runweave-evolution.url"))) process.exit(22);
  if (!args.some((arg) => arg.includes("bearer_token_env_var"))) process.exit(23);
  if (process.env.RUNWEAVE_EVOLUTION_MCP_TOKEN !== "fixture-mcp-token") process.exit(24);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.trim() === "hang") {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const outputIndex = args.indexOf("--output-last-message");
await writeFile(args[outputIndex + 1], JSON.stringify({ summary: prompt.trim() }));
console.log(JSON.stringify({ type: "fake.completed" }));
`,
    "utf8",
  );
  await chmod(fakeProviderPath, 0o700);
  await writeFile(
    schemaPath,
    JSON.stringify({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    }),
    "utf8",
  );
  const request = {
    prompt: "bounded reflection",
    workingDirectory: providerRoot,
    outputSchemaPath: schemaPath,
    maxWallTimeMs: 5_000,
    maxOutputBytes: 64 * 1024,
  };
  for (const provider of [
    new CodexEvolutionProvider(fakeProviderPath),
    new TraeEvolutionProvider(fakeProviderPath),
  ]) {
    const result = await provider.run(request);
    assert.deepEqual(result.output, { summary: "bounded reflection" });
    assert.equal(result.events.length, 1);
  }
  const result = await new CodexEvolutionProvider(fakeProviderPath).run({
    ...request,
    mcp: {
      url: "http://127.0.0.1:43123/internal/evolution/mcp",
      bearerToken: "fixture-mcp-token",
    },
  });
  assert.deepEqual(result.output, { summary: "bounded reflection" });
  await assert.rejects(
    new CodexEvolutionProvider(fakeProviderPath).run({
      ...request,
      prompt: "hang",
      maxWallTimeMs: 50,
    }),
    /provider_timeout/,
  );
}
