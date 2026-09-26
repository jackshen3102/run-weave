import { randomUUID } from "node:crypto";
import { requireDesktopMigration } from "../desktop/configuration-migration.js";
import { ConfigurationDomain, configuration, ConfigurationError } from "@runweave/config-node";
import { validateTunnelUpdate, isTunnelId, type TunnelConfig, type TunnelConfigUpdate } from "@runweave/shared/tunnels";

type StoredTunnelConfig = Omit<TunnelConfig, "schemaVersion">;
export class TunnelStore {
  readonly file = configuration().store.file;
  private readonly domain = new ConfigurationDomain<StoredTunnelConfig>("desktop.tunnels");
  private current: TunnelConfig;
  constructor() {
    requireDesktopMigration("desktop.tunnels.desktopId", "tunnels/config.json");
    const saved = this.domain.read();
    if (saved) {
      if (!isTunnelId(saved.desktopId) || !Array.isArray(saved.completedImports) || !saved.completedImports.every(isTunnelId)) throw new ConfigurationError("CONFIG_TUNNELS_INVALID");
      const clean = validateTunnelUpdate({ ...saved, expectedRevision: saved.revision });
      this.current = { ...saved, ...clean, schemaVersion: 1 };
    } else {
      this.current = { schemaVersion: 1, revision: 0, desktopId: randomUUID(), hosts: [], backendEndpoints: [], completedImports: [] };
      this.persist(this.current);
    }
    this.domain.markApplied();
  }
  private persist(value: TunnelConfig): void {
    this.domain.write({ revision: value.revision, desktopId: value.desktopId, hosts: value.hosts, backendEndpoints: value.backendEndpoints, completedImports: value.completedImports });
  }
  read(): TunnelConfig { return structuredClone(this.current); }
  save(input: TunnelConfigUpdate, migrationId?: string): TunnelConfig {
    if (migrationId && this.current.completedImports.includes(migrationId)) return this.read();
    const clean = validateTunnelUpdate(input);
    if (clean.expectedRevision !== this.current.revision) throw new ConfigurationError("CONFIG_REVISION_CONFLICT");
    const next: TunnelConfig = { ...this.current, hosts: clean.hosts, backendEndpoints: clean.backendEndpoints, revision: this.current.revision + 1, completedImports: migrationId ? [...this.current.completedImports, migrationId] : this.current.completedImports };
    this.persist(next);
    this.current = next;
    this.domain.markApplied();
    return this.read();
  }
}
