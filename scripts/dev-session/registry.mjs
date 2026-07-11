import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  link,
  open,
  readdir,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DevSessionError,
  assertDevSessionId,
  assertPathInside,
  publicManifest,
  validateManifest,
} from "./contracts.mjs";

export function resolveDevSessionRoot(env = process.env) {
  return path.resolve(
    env.RUNWEAVE_DEV_SESSION_HOME?.trim() ||
      path.join(os.homedir(), ".runweave", "dev-sessions"),
  );
}

export function resolveSessionPaths(sessionId, env = process.env) {
  const safeId = assertDevSessionId(sessionId);
  const root = resolveDevSessionRoot(env);
  const sessionDir = assertPathInside(
    root,
    path.join(root, safeId),
    "session directory",
  );
  return {
    root,
    sessionDir,
    manifestPath: path.join(sessionDir, "manifest.json"),
    lockPath: path.join(sessionDir, "session.lock"),
    logsDir: path.join(sessionDir, "logs"),
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectDirectory(directory, label) {
  let handle;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new DevSessionError(`${label} must be a directory`, 4, {
        directory,
      });
    }
    return { handle, stats };
  } catch (error) {
    await handle?.close();
    if (error instanceof DevSessionError) {
      throw error;
    }
    throw new DevSessionError(`${label} must not contain symlinks`, 4, {
      directory,
    });
  }
}

async function ensurePrivateDirectory(directory, allowedRoot = directory) {
  const root = assertPathInside(allowedRoot, allowedRoot, "directory root");
  const target = assertPathInside(root, directory, "directory");
  if (target === root) {
    try {
      const stats = await lstat(root);
      if (stats.isSymbolicLink()) {
        throw new DevSessionError("directory root must not be a symlink", 4, {
          directory: root,
        });
      }
    } catch (error) {
      if (error instanceof DevSessionError) {
        throw error;
      }
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
    const rootDirectory = await inspectDirectory(root, "directory root");
    try {
      await rootDirectory.handle.chmod(0o700);
    } finally {
      await rootDirectory.handle.close();
    }
    return;
  }

  const relative = path.relative(root, target);
  let parent = root;
  for (const component of relative.split(path.sep)) {
    const parentDirectory = await inspectDirectory(parent, "directory parent");
    const next = path.join(parent, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await parentDirectory.handle.close();
        throw error;
      }
    }
    const currentParent = await inspectDirectory(
      parent,
      "directory parent after create",
    );
    await parentDirectory.handle.close();
    await currentParent.handle.close();
    if (!sameFileIdentity(parentDirectory.stats, currentParent.stats)) {
      throw new DevSessionError("directory parent identity changed", 4, {
        directory: parent,
      });
    }
    const nextDirectory = await inspectDirectory(next, "session directory");
    try {
      await nextDirectory.handle.chmod(0o700);
    } finally {
      await nextDirectory.handle.close();
    }
    parent = next;
  }
}

async function assertSafeParent(allowedRoot, filePath) {
  const directory = path.dirname(
    assertPathInside(allowedRoot, filePath, "file path"),
  );
  const relative = path.relative(allowedRoot, directory);
  let current = allowedRoot;
  const components = relative ? relative.split(path.sep) : [];
  for (const component of ["", ...components]) {
    if (component) {
      current = path.join(current, component);
    }
    const inspected = await inspectDirectory(current, "file parent");
    await inspected.handle.close();
  }
}

async function removeFileNoFollow(filePath, allowedRoot, expectedStats = null) {
  await assertSafeParent(allowedRoot, filePath);
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new DevSessionError("refusing to remove a non-regular session file", 4, {
      filePath,
    });
  }
  if (expectedStats && !sameFileIdentity(stats, expectedStats)) {
    throw new DevSessionError("session file identity changed", 4, {
      filePath,
    });
  }
  await rm(filePath);
}

export async function atomicWriteJson(
  filePath,
  value,
  allowedRoot = path.dirname(filePath),
) {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory, allowedRoot);
  const temporaryPath = assertPathInside(
    directory,
    path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`),
    "temporary file",
  );
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertSafeParent(allowedRoot, filePath);
  await rename(temporaryPath, filePath);
}

export async function writeManifest(manifest, env = process.env) {
  const sanitized = publicManifest(manifest);
  const paths = resolveSessionPaths(sanitized.devSessionId, env);
  await ensurePrivateDirectory(paths.root, paths.root);
  await ensurePrivateDirectory(paths.sessionDir, paths.root);
  await ensurePrivateDirectory(paths.logsDir, paths.root);
  await atomicWriteJson(paths.manifestPath, sanitized, paths.root);
  return paths;
}

export async function readManifest(sessionId, env = process.env) {
  const { root, manifestPath } = resolveSessionPaths(sessionId, env);
  let handle;
  try {
    await assertSafeParent(root, manifestPath);
    handle = await open(
      manifestPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new DevSessionError("manifest must be a regular file", 4, {
        manifestPath,
      });
    }
    return validateManifest(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error instanceof DevSessionError) {
      throw error;
    }
    throw new DevSessionError(`dev session not found: ${sessionId}`, 3, {
      manifestPath,
    });
  } finally {
    await handle?.close();
  }
}

export async function listManifestsForSource(sourceRoot, env = process.env) {
  const root = resolveDevSessionRoot(env);
  let entries;
  try {
    const inspectedRoot = await inspectDirectory(root, "dev session root");
    await inspectedRoot.handle.close();
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const manifest = await readManifest(entry.name, env);
      if (path.resolve(manifest.source.root) === path.resolve(sourceRoot)) {
        manifests.push(manifest);
      }
    } catch {
      // Invalid or newer manifests are not candidates for mutation.
    }
  }
  return manifests.sort((left, right) =>
    left.devSessionId.localeCompare(right.devSessionId),
  );
}

export async function resolveManifestCandidate({
  sessionId,
  sourceRoot,
  env = process.env,
}) {
  if (sessionId) {
    return readManifest(sessionId, env);
  }
  const envSessionId = env.RUNWEAVE_DEV_SESSION_ID?.trim();
  if (envSessionId) {
    return readManifest(envSessionId, env);
  }
  const candidates = (await listManifestsForSource(sourceRoot, env)).filter(
    (manifest) =>
      ["starting", "ready", "stale", "failed"].includes(manifest.state),
  );
  if (candidates.length !== 1) {
    throw new DevSessionError(
      candidates.length === 0
        ? "no live dev session candidate for this source root"
        : "multiple dev session candidates; pass --session",
      3,
      {
        candidates: candidates.map(
          ({ devSessionId, profile, state, source }) => ({
            devSessionId,
            profile,
            state,
            revision: source.revision,
          }),
        ),
      },
    );
  }
  return candidates[0];
}

export async function withSessionLock(sessionId, callback, env = process.env) {
  const paths = resolveSessionPaths(sessionId, env);
  await ensurePrivateDirectory(paths.root, paths.root);
  await ensurePrivateDirectory(paths.sessionDir, paths.root);
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(paths.lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const owner = await readJsonFile(paths.lockPath, paths.root);
      if (owner && isProcessLive(owner.pid)) {
        throw new DevSessionError(`dev session is busy: ${sessionId}`, 5, {
          ownerPid: owner.pid,
          acquiredAt: owner.acquiredAt ?? null,
        });
      }
      await removeFileNoFollow(paths.lockPath, paths.root);
    }
  }
  if (!handle) {
    throw new DevSessionError(
      `failed to acquire dev session lock: ${sessionId}`,
      5,
    );
  }
  try {
    return await callback(paths);
  } finally {
    const lockStats = await handle?.stat();
    await handle?.close();
    await removeFileNoFollow(paths.lockPath, paths.root, lockStats);
  }
}

export async function acquireServicePortLease(root, port, sessionId) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DevSessionError("service port lease requires a valid port", 4, {
      port,
    });
  }
  const safeSessionId = assertDevSessionId(sessionId);
  const safeRoot = assertPathInside(root, root, "port lease root");
  const leaseDirectory = path.join(safeRoot, ".port-leases");
  await ensurePrivateDirectory(safeRoot, safeRoot);
  await ensurePrivateDirectory(leaseDirectory, safeRoot);
  const lockPath = assertPathInside(
    safeRoot,
    path.join(leaseDirectory, `${port}.lock`),
    "port lease",
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidatePath = assertPathInside(
      safeRoot,
      path.join(leaseDirectory, `.${port}.${randomUUID()}.tmp`),
      "port lease candidate",
    );
    let candidateHandle;
    let candidateStats = null;
    let published = false;
    try {
      candidateHandle = await open(
        candidatePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      candidateStats = await candidateHandle.stat();
      await candidateHandle.writeFile(
        `${JSON.stringify({ pid: process.pid, sessionId: safeSessionId, acquiredAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await candidateHandle.chmod(0o600);
      await candidateHandle.sync();
      await candidateHandle.close();
      candidateHandle = null;
      const namedCandidateStats = await lstat(candidatePath);
      if (
        !namedCandidateStats.isFile() ||
        namedCandidateStats.isSymbolicLink() ||
        !sameFileIdentity(candidateStats, namedCandidateStats)
      ) {
        throw new DevSessionError("port lease candidate identity changed", 4, {
          port,
        });
      }
      await assertSafeParent(safeRoot, lockPath);
      await link(candidatePath, lockPath);
      published = true;
      const lockStats = await lstat(lockPath);
      if (!lockStats.isFile() || !sameFileIdentity(candidateStats, lockStats)) {
        throw new DevSessionError("published port lease identity changed", 4, {
          port,
        });
      }
      await removeFileNoFollow(candidatePath, safeRoot, candidateStats);
      let released = false;
      return {
        port,
        async release() {
          if (released) {
            return;
          }
          released = true;
          await removeFileNoFollow(lockPath, safeRoot, lockStats);
        },
      };
    } catch (error) {
      await candidateHandle?.close();
      if (published && candidateStats) {
        await removeFileNoFollow(
          lockPath,
          safeRoot,
          candidateStats,
        ).catch(() => undefined);
      }
      await removeFileNoFollow(
        candidatePath,
        safeRoot,
        candidateStats,
      ).catch(() => undefined);
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = await readJsonFileWithStats(lockPath, safeRoot);
      const owner = existing?.value;
      const validOwner =
        owner &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        typeof owner.sessionId === "string";
      if (!validOwner || isProcessLive(owner.pid)) {
        return null;
      }
      try {
        await removeFileNoFollow(lockPath, safeRoot, existing.stats);
      } catch (removeError) {
        if (removeError instanceof DevSessionError) {
          return null;
        }
        throw removeError;
      }
    }
  }
  return null;
}

async function readJsonFileWithStats(filePath, allowedRoot) {
  let handle;
  try {
    await assertSafeParent(allowedRoot, filePath);
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    let value = null;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      // Invalid legacy/corrupt leases are preserved so ownership fails closed.
    }
    return { stats, value };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readJsonFile(filePath, allowedRoot) {
  let handle;
  try {
    await assertSafeParent(allowedRoot, filePath);
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function isProcessLive(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
