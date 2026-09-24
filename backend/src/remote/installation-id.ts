import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function loadInstallationId(storageDirectory: string): Promise<string> {
  const file = path.join(storageDirectory, "installation-id");
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
    throw new Error("Invalid Runweave installation ID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  try {
    await writeFile(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
    throw new Error("Invalid Runweave installation ID");
  }
}
