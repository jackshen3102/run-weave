import { createPool } from "../src/db/pool";
import { cutover } from "../src/browse/cutover";
import { uuid } from "../src/schema";
const pool = createPool(process.env.MIGRATION_DATABASE_URL ?? "");
try {
  // No secrets in argv; application requires the exact reviewed dry-run hash on stdin.
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 8192) throw new Error();
  }
  const input = JSON.parse(value);
  console.log(
    JSON.stringify(
      await cutover(pool, uuid.parse(input.ownerId), input.expectedHash),
    ),
  );
} catch {
  console.error("Browse cutover failed; verify identity and dry-run hash");
  process.exitCode = 1;
} finally {
  await pool.end();
}
