import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import type { LocalRemoteDesktopInfo } from "@runweave/shared/tunnels";

export async function getLocalRemoteDesktopInfo(): Promise<LocalRemoteDesktopInfo> {
  if (process.platform !== "darwin") throw new Error("自动获取 RemoteDesk 信息仅支持本机 Mac。");
  const directory = path.join(homedir(), "Library", "Application Support", "RemoteDesk");
  let info: LocalRemoteDesktopInfo;
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077))
      throw new Error("unsafe directory");
    const file = await open(path.join(directory, "local-host.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096)
        throw new Error("unsafe metadata");
      const data = JSON.parse(await file.readFile("utf8"));
      if (data.schemaVersion !== 1 || data.running !== true || !Number.isInteger(data.pid) || data.pid <= 0 ||
        typeof data.localAddress !== "string" || !Number.isInteger(data.localPort) || data.localPort < 1 || data.localPort > 65535 ||
        typeof data.certificateFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.certificateFingerprint))
        throw new Error("unavailable metadata");
      process.kill(data.pid, 0);
      const local = Object.values(networkInterfaces()).flat().some((entry) =>
        entry?.family === "IPv4" && !entry.internal && entry.address === data.localAddress);
      if (!local) throw new Error("stale address");
      info = { localAddress: data.localAddress, localPort: data.localPort, certificateFingerprint: data.certificateFingerprint };
    } finally { await file.close(); }
  } catch {
    throw new Error("REMOTE_DESKTOP_LOCAL_UNAVAILABLE: 请启动本机 RemoteDesk 的局域网服务；旧版 RemoteDesk 需先更新，才能自动获取连接信息。");
  }
  return info;
}
