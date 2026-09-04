import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function verifyBackendProfileLockPublication(
  sourceRoot,
  temporaryHome,
) {
  const profileDir = path.join(temporaryHome, "backend-profile-lock");
  const verificationSource = `
    import { mkdir, open, readFile, rm, utimes } from "node:fs/promises";
    import path from "node:path";
    import {
      acquireBackendProfileLock,
      BackendProfileLockConflictError,
    } from "./src/server/profile-lock.ts";

    void (async () => {
    const profileDir = process.env.RUNWEAVE_VERIFY_PROFILE_DIR;
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(profileDir, "backend.lock.json");
    const partialCreator = await open(lockFile, "wx", 0o600);
    await utimes(lockFile, new Date(0), new Date(0));
    let partialFailedClosed = false;
    try {
      await acquireBackendProfileLock({
        devSessionId: "dvs-profile-competitor",
        profileDir,
        port: 6206,
        host: "127.0.0.1",
      });
    } catch (error) {
      partialFailedClosed = error instanceof BackendProfileLockConflictError;
    }
    await partialCreator.close();
    await rm(lockFile);

    const lock = await acquireBackendProfileLock({
      devSessionId: "dvs-profile-owner",
      profileDir,
      port: 6206,
      host: "127.0.0.1",
    });
    const createdOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.update({ port: 6207 });
    const updatedOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.release();
    process.stdout.write(JSON.stringify({
      partialFailedClosed,
      createdDevSessionId: createdOwner.devSessionId,
      createdPort: createdOwner.port,
      updatedPort: updatedOwner.port,
      identityStable:
        createdOwner.backendId === updatedOwner.backendId &&
        createdOwner.pid === updatedOwner.pid,
    }) + "\\n");
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["-C", "backend", "exec", "tsx", "-e", verificationSource],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        RUNWEAVE_VERIFY_PROFILE_DIR: profileDir,
      },
    },
  );
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(result, {
    partialFailedClosed: true,
    createdDevSessionId: "dvs-profile-owner",
    createdPort: 6206,
    updatedPort: 6207,
    identityStable: true,
  });
}
