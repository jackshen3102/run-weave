import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "output-dir": { type: "string" },
    days: { type: "string", default: "90" },
  },
});
const output = values["output-dir"];
const days = Number(values.days);
if (
  !output ||
  !path.isAbsolute(output) ||
  !Number.isInteger(days) ||
  days < 1 ||
  days > 365
)
  throw new Error("Use --output-dir <new absolute directory> [--days 1..365]");
// A new directory avoids overwriting a credential already in use.
await mkdir(output, { mode: 0o700 });
const token = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(token).digest("hex");
const expires = new Date(Date.now() + days * 86400000).toISOString();
await writeFile(path.join(output, "client.env"), `SUIJI_MCP_TOKEN=${token}\n`, {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  path.join(output, "server.env"),
  `SUIJI_MCP_TOKEN_SHA256=${digest}\nSUIJI_MCP_TOKEN_EXPIRES_AT=${expires}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify({
    clientConfig: path.join(output, "client.env"),
    serverConfig: path.join(output, "server.env"),
    expiresAt: expires,
  }),
);
