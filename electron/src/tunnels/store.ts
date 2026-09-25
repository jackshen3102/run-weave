import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateTunnelUpdate,
  isTunnelId,
  type TunnelConfig,
  type TunnelConfigUpdate,
} from "@runweave/shared/tunnels";
import { desktopStateRoot, writePrivateJson } from "../desktop/local-state.js";

export class TunnelStore {
  readonly file = path.join(desktopStateRoot(), "tunnels", "config.json");
  private current: TunnelConfig;
  constructor() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as TunnelConfig;
        if (
          raw.schemaVersion !== 1 ||
          !isTunnelId(raw.desktopId) ||
          !Array.isArray(raw.completedImports) ||
          !raw.completedImports.every(isTunnelId)
        )
          throw new Error();
        const clean = validateTunnelUpdate({
          ...raw,
          expectedRevision: raw.revision,
        });
        this.current = {
          schemaVersion: 1,
          revision: raw.revision,
          desktopId: raw.desktopId,
          hosts: clean.hosts,
          backendEndpoints: clean.backendEndpoints,
          completedImports: raw.completedImports,
        };
      } catch {
        throw new Error("CONFIG_CORRUPT: 隧道配置无法读取，请从备份恢复");
      }
    } else {
      this.current = {
        schemaVersion: 1,
        revision: 0,
        desktopId: randomUUID(),
        hosts: [],
        backendEndpoints: [],
        completedImports: [],
      };
      writePrivateJson(this.file, this.current);
    }
  }
  read(): TunnelConfig {
    return structuredClone(this.current);
  }
  save(input: TunnelConfigUpdate, migrationId?: string): TunnelConfig {
    if (migrationId && this.current.completedImports.includes(migrationId))
      return this.read();
    const clean = validateTunnelUpdate(input);
    if (clean.expectedRevision !== this.current.revision)
      throw new Error("CONFIG_REVISION_CONFLICT: 配置已更新，请重新读取");
    const next: TunnelConfig = {
      ...this.current,
      hosts: clean.hosts,
      backendEndpoints: clean.backendEndpoints,
      revision: this.current.revision + 1,
      completedImports: migrationId
        ? [...this.current.completedImports, migrationId]
        : this.current.completedImports,
    };
    try {
      writePrivateJson(`${this.file}.bak`, this.current);
      writePrivateJson(this.file, next);
    } catch {
      throw new Error("CONFIG_WRITE_FAILED: 配置未保存，原配置保持不变");
    }
    this.current = next;
    return this.read();
  }
}
