import {
  lstat,
  readdir,
  readFile,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface ChromeManifest {
  manifest_version: 2 | 3;
  name: string;
  version: string;
  key?: string;
  permissions?: string[];
  host_permissions?: string[];
  background?: { service_worker?: string };
  action?: { default_popup?: string };
  browser_action?: { default_popup?: string };
  content_scripts?: Array<{ matches?: string[] }>;
}
export async function readChromeManifest(
  directory: string,
): Promise<ChromeManifest> {
  const file = path.join(directory, "manifest.json"),
    stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error("扩展 manifest.json 不可读或超过 256 KiB");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (
    !value ||
    ![2, 3].includes(value.manifest_version) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 200 ||
    typeof value.version !== "string" ||
    !/^\d+(\.\d+){0,3}$/.test(value.version) ||
    (value.key !== undefined &&
      (typeof value.key !== "string" || value.key.length > 8192)) ||
    ["permissions", "host_permissions"].some(
      (k) =>
        value[k] !== undefined &&
        (!Array.isArray(value[k]) ||
          value[k].length > 100 ||
          value[k].some(
            (p: unknown) => typeof p !== "string" || p.length > 2048,
          )),
    ) ||
    (value.content_scripts !== undefined &&
      (!Array.isArray(value.content_scripts) ||
        value.content_scripts.length > 100 ||
        value.content_scripts.some(
          (s: { matches?: unknown }) =>
            !s ||
            typeof s !== "object" ||
            !Array.isArray(s.matches) ||
            s.matches.some((m) => typeof m !== "string" || m.length > 2048),
        )))
  )
    throw Error("扩展 manifest 格式不受支持");
  return value;
}
export function chromePermissionSummary(manifest: ChromeManifest) {
  const hosts = manifest.content_scripts?.flatMap((s) => s.matches ?? []) ?? [];
  if (
    hosts.some((h) => typeof h !== "string" || h.length > 2048) ||
    hosts.length > 500
  )
    throw Error("扩展 content_scripts matches 不合法");
  const permissions = [
    ...new Set([
      ...(manifest.permissions ?? []),
      ...(manifest.host_permissions ?? []),
      ...hosts,
    ]),
  ];
  const warnings = (manifest.permissions ?? [])
    .filter(
      (p) =>
        ![
          "storage",
          "scripting",
          "tabs",
          "webRequest",
          "webRequestBlocking",
        ].includes(p) && !p.includes("://"),
    )
    .map((p) => `${p} 未列入 Electron 官方承诺支持的 API 范围，需逐项验证`);
  warnings.push(
    "storage 仅支持 local，tabs 仅部分支持；声明权限不代表功能可用",
  );
  if (manifest.background?.service_worker)
    warnings.push("MV3 后台 Worker 及其 API 需要实际验证");
  return { permissions, warnings };
}
/** Reject links and special files, and bound traversal before copying anything. */
export async function copyChromePackage(source: string, destination: string) {
  const root = await realpath(source);
  if (destination.startsWith(root + path.sep))
    throw Error("不能从插件管理目录的父目录安装扩展");
  const files: Array<{ relative: string; source: string }> = [];
  let bytes = 0,
    entries = 0;
  async function scan(relative: string, depth: number) {
    if (depth > 20) throw Error("扩展目录层级超过 20");
    for (const name of await readdir(path.join(root, relative))) {
      const next = path.join(relative, name),
        file = path.join(root, next),
        stat = await lstat(file);
      if (++entries > 10000 || stat.isSymbolicLink())
        throw Error("扩展不能包含软链接，文件数上限 10000");
      if (stat.isDirectory()) await scan(next, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 100 * 1024 * 1024) throw Error("扩展解包大小超过 100 MiB");
        files.push({ relative: next, source: file });
      } else throw Error("扩展不能包含特殊文件");
    }
  }
  await scan("", 0);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  let copiedBytes = 0;
  for (const file of files) {
    const target = path.join(destination, file.relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Check containment again and open the leaf without following a symlink.
    if (!(await realpath(file.source)).startsWith(root + path.sep))
      throw Error("扩展文件在安装期间发生变化");
    const input = await open(
      file.source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!(await input.stat()).isFile())
        throw Error("扩展文件在安装期间发生变化");
      const output = await open(target, "wx", 0o600);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          copiedBytes += bytesRead;
          if (copiedBytes > 100 * 1024 * 1024)
            throw Error("扩展解包大小超过 100 MiB");
          await output.writeFile(buffer.subarray(0, bytesRead));
        }
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
}
