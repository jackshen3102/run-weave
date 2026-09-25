import path from "node:path";
import { existsSync } from "node:fs";
import { desktopStateRoot, writePrivateJson } from "../desktop/local-state.js";
import { resolveTunnelService } from "./service-access.js";
import { ipcMain, safeStorage } from "electron";
import {
  isTunnelId,
  validateTunnelUpdate,
  type TunnelImport,
  type TunnelLogin,
} from "@runweave/shared/tunnels";
import { desktopRuntime } from "../desktop/runtime-state.js";
import { TunnelManager } from "./manager.js";
let manager: TunnelManager | null = null;
let startupError: string | null = null;
export function registerTunnelHandlers(): void {
  try {
    manager = new TunnelManager();
    manager.start();
  } catch (error) {
    startupError =
      error instanceof Error ? error.message : "TUNNEL_START_FAILED";
  }
  const get = (senderId: number) => {
    if (desktopRuntime.mainWindow?.webContents.id !== senderId)
      throw new Error("Main window sender required");
    if (!manager) throw new Error(startupError ?? "TUNNEL_UNAVAILABLE");
    return manager;
  };
  ipcMain.handle("tunnels:list", (event) => get(event.sender.id).snapshot());
  ipcMain.handle("tunnels:save-config", (event, input: unknown) =>
    get(event.sender.id).save(validateTunnelUpdate(input)),
  );
  ipcMain.handle("tunnels:connect", (event, id: unknown) => {
    if (!isTunnelId(id)) throw new Error("INVALID_HOST_ID");
    return get(event.sender.id).connect(id);
  });
  ipcMain.handle("tunnels:disconnect", (event, id: unknown) => {
    if (!isTunnelId(id)) throw new Error("INVALID_HOST_ID");
    return get(event.sender.id).disconnect(id);
  });
  ipcMain.handle("tunnels:retry", (event, id: unknown, forwardId: unknown) => {
    if (!isTunnelId(id) || (forwardId !== undefined && !isTunnelId(forwardId)))
      throw new Error("INVALID_HOST_ID");
    return get(event.sender.id).retry(id, forwardId as string | undefined);
  });
  ipcMain.handle("tunnels:login", (event, input: TunnelLogin) => {
    if (
      !input ||
      !isTunnelId(input.hostId) ||
      typeof input.username !== "string" ||
      typeof input.password !== "string" ||
      input.username.length > 256 ||
      input.password.length > 4096
    )
      throw new Error("INVALID_LOGIN");
    return get(event.sender.id).login(
      input.hostId,
      input.username,
      input.password,
    );
  });
  ipcMain.handle(
    "tunnels:select-browser",
    (event, id: unknown, terminalId: unknown) => {
      if (!isTunnelId(id) || !isTunnelId(terminalId))
        throw new Error("INVALID_TERMINAL");
      return get(event.sender.id).selectBrowser(id, terminalId);
    },
  );
  ipcMain.handle(
    "tunnels:resolve-service",
    (event, ref: unknown, token: unknown) => {
      const m = get(event.sender.id);
      return resolveTunnelService(() => m.snapshot(), ref, token);
    },
  );
  ipcMain.handle("tunnels:import", (event, input: TunnelImport) => {
    if (!input || !isTunnelId(input.migrationId))
      throw new Error("INVALID_IMPORT");
    const m = get(event.sender.id);
    const clean = validateTunnelUpdate(input);
    const backup = JSON.stringify(input.backup);
    if (!input.backup || backup.length > 4 * 1024 * 1024)
      throw new Error("INVALID_IMPORT_BACKUP");
    const file = path.join(
      desktopStateRoot(),
      "tunnels",
      `migration-${input.migrationId}.enc`,
    );
    if (!existsSync(file)) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("安全加密不可用，旧配置尚未迁移");
      writePrivateJson(file, {
        encrypted: safeStorage.encryptString(backup).toString("base64"),
      });
    }
    return m.save(clean, input.migrationId);
  });
}
export async function stopTunnels() {
  await manager?.stop();
}
