import pg from "pg";
import { z } from "zod";
import { hashPassword } from "../src/auth/password";
import { transaction } from "../src/db/pool";
const action = process.argv[2];
if (!["init", "reset"].includes(action ?? ""))
  throw new Error("Expected init or reset; credentials are JSON on stdin");
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL required");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) throw new Error("Input too large");
}
const credentials = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(12).max(1024),
  })
  .strict()
  .safeParse(JSON.parse(input));
if (!credentials.success)
  throw new Error(
    "Invalid credential fields (password requires at least 12 characters)",
  );
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
try {
  const hash = await hashPassword(credentials.data.password);
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(78347831)");
    const owner = (
      await client.query("SELECT id FROM owners WHERE singleton FOR UPDATE")
    ).rows[0];
    if (owner && action === "init") {
      console.log("Already initialized; identity and credentials unchanged");
      return;
    }
    if (owner) {
      await client.query(
        "UPDATE owners SET username=$1,password_hash=$2 WHERE id=$3",
        [credentials.data.username, hash, owner.id],
      );
      await client.query(
        "UPDATE sessions SET revoked_at=now() WHERE owner_id=$1",
        [owner.id],
      );
    } else if (action === "init")
      await client.query(
        "INSERT INTO owners(username,password_hash) VALUES($1,$2)",
        [credentials.data.username, hash],
      );
    else throw new Error("Initialize owner first");
    console.log("Credentials stored; stable identity preserved");
  });
} finally {
  await pool.end();
}
