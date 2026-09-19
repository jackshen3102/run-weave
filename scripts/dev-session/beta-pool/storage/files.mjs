import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DevSessionError, assertPathInside } from "../../contracts.mjs";

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function ensureDirectory(directory, allowedRoot) {
  const root = path.resolve(allowedRoot);
  const target = assertPathInside(root, directory, "Beta pool directory");
  const existingRoot = await fs.lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existingRoot?.isSymbolicLink()) {
    throw new DevSessionError("Beta pool root must not be a symlink", 4, {
      path: root,
    });
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new DevSessionError("Beta pool root must not be a symlink", 4, {
      path: root,
    });
  }
  await fs.chmod(root, 0o700);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new DevSessionError("Beta pool path must not contain symlinks", 4, {
        path: current,
      });
    }
    await fs.chmod(current, 0o700);
  }
}

export async function readRegularJson(filePath, allowedRoot) {
  assertPathInside(allowedRoot, filePath, "Beta pool file");
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("not a regular file");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    const named = await fs.lstat(filePath);
    if (named.isSymbolicLink() || !sameFileIdentity(before, named)) {
      throw new Error("file identity changed while reading");
    }
    return { value, stats: named };
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteJson(filePath, value, allowedRoot) {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory, allowedRoot);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
}
