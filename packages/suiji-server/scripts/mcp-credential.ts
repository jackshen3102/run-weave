import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { registrationSchema } from "../src/mcp/credentials";

try {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" }, days: { type: "string", default: "90" },
      name: { type: "string" }, "server-id": { type: "string" }, "owner-id": { type: "string" },
      legacy: { type: "boolean", default: false },
    },
  });
  const output = values["output-dir"], days = Number(values.days);
  if (!output || !path.isAbsolute(output) || !Number.isInteger(days) || days < 1 || days > 365)
    throw new Error("INVALID_INPUT");
  if (values.legacy && (values.name || values["server-id"] || values["owner-id"]))
    throw new Error("INVALID_INPUT");
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const registration = values.legacy ? undefined : registrationSchema.parse({
    version: 1, id: randomUUID(), name: values.name, serverId: values["server-id"],
    ownerId: values["owner-id"], tokenSha256, expiresAt,
  });
  // Never overwrite an existing device's secret; partial failures retain private files for inspection.
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, "client.env"), `SUIJI_MCP_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
  const file = registration ? "registration.json" : "server.env";
  await writeFile(path.join(output, file), registration ? JSON.stringify(registration, null, 2) + "\n" :
    `SUIJI_MCP_TOKEN_SHA256=${tokenSha256}\nSUIJI_MCP_TOKEN_EXPIRES_AT=${expiresAt}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ clientConfig: path.join(output, "client.env"),
    registration: path.join(output, file), id: registration?.id, expiresAt }));
} catch {
  console.error("Credential generation failed; check inputs and use a new absolute output directory");
  process.exitCode = 1;
}
