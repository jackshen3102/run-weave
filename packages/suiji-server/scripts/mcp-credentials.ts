import { parseArgs } from "node:util";
import { createPool } from "../src/db/pool";
import { CredentialError, listCredentials, registerCredential, revokeCredential } from "../src/mcp/credentials";

let pool: ReturnType<typeof createPool> | undefined;
try {
  const { values, positionals } = parseArgs({
    options: { id: { type: "string" } }, allowPositionals: true,
  });
  const action = positionals[0];
  if (positionals.length !== 1 || !["register", "list", "revoke", "import-legacy"].includes(action ?? "") ||
      (action === "revoke" ? !values.id : values.id !== undefined))
    throw new CredentialError("INVALID_INPUT");
  if (!process.env.MIGRATION_DATABASE_URL) throw new CredentialError("MIGRATION_DATABASE_URL_REQUIRED");
  pool = createPool(process.env.MIGRATION_DATABASE_URL);
  let result: unknown;
  if (action === "list") result = { items: await listCredentials(pool) };
  else if (action === "revoke") result = await revokeCredential(pool, values.id!);
  else {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 8192) throw new CredentialError("INVALID_INPUT");
    }
    let data: unknown;
    try { data = JSON.parse(input); } catch { throw new CredentialError("INVALID_INPUT"); }
    result = await registerCredential(pool, data, action === "import-legacy");
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof CredentialError ? error.message : "CREDENTIAL_OPERATION_FAILED" }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
