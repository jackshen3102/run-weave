import { createRequire } from "node:module";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);
/** Migration also runs inside app.asar; use the same staged driver as Experience. */
export function openEvolutionDatabase(file: string, options: Database.Options = {}): Database.Database {
  const Driver = require(process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR ?? "better-sqlite3") as typeof Database;
  return new Driver(file, { ...options, nativeBinding: process.env.RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING });
}
