import { z } from "zod";
import { createPool } from "../src/db/pool";
import { transaction } from "../src/db/pool";
import { listSources, registerSource, stopSource } from "../src/work-records/sources";

const action = process.argv[2];
if (!["register", "stop", "list"].includes(action ?? "") || !process.env.MIGRATION_DATABASE_URL)
  throw new Error("Expected register/stop/list and MIGRATION_DATABASE_URL; JSON on stdin");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 8192) throw new Error("Input too large");
}
const { ownerId, ...data } = JSON.parse(input);
z.string().uuid().parse(ownerId);
const pool = createPool(process.env.MIGRATION_DATABASE_URL);
try {
  const result = action === "register" ? await registerSource(pool, ownerId, data)
    : action === "stop" ? await stopSource(pool, ownerId, data)
    : await transaction(pool, c => listSources(c, ownerId, data));
  console.log(JSON.stringify(result));
} catch {
  console.error("WORK_SOURCE_OPERATION_FAILED; check identity, fields and source intervals");
  process.exitCode = 1;
} finally { await pool.end(); }
