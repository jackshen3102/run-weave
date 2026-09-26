import { readConfigurationPath, type ConfigurationValue } from "@runweave/shared/configuration";
import { configuration } from "./runtime";
import { ConfigurationError } from "./errors";
import { domainForPath } from "./validation";
import type { ConfigurationSnapshot } from "./store";

/** A UI-owned domain read retains the global CAS stamp until its next save. */
export class ConfigurationDomain<T> {
  private observed: { revision: number; digest: string } | undefined;
  private snapshot: ConfigurationSnapshot | undefined;
  constructor(readonly key: string) {}
  read(): T | undefined {
    const snapshot = configuration().store.read();
    if (snapshot.issues[domainForPath(this.key)]?.length) throw new ConfigurationError("CONFIG_DOMAIN_INVALID", [this.key]);
    this.observed = { revision: snapshot.value.revision, digest: snapshot.digest };
    this.snapshot = snapshot;
    return structuredClone(readConfigurationPath(snapshot.value, this.key)) as T | undefined;
  }
  restore(keys = [this.key]): void {
    this.read();
    this.patch(configuration().store.previous(keys));
  }
  write(value: T): void {
    if (!this.observed) throw new ConfigurationError("CONFIG_READ_BEFORE_WRITE_REQUIRED");
    this.patch({ [this.key]: value as ConfigurationValue });
  }
  /** Called by the owner only after it adopts the read/written values. */
  markApplied(keys = [this.key]): void {
    if (!this.snapshot) throw new ConfigurationError("CONFIG_READ_BEFORE_WRITE_REQUIRED");
    configuration().markSnapshotApplied(this.snapshot, ...keys);
  }
  patch(changes: Record<string, ConfigurationValue>): void {
    if (!this.observed) throw new ConfigurationError("CONFIG_READ_BEFORE_WRITE_REQUIRED");
    const next = configuration().store.patch({ expectedRevision: this.observed.revision, expectedDigest: this.observed.digest, changes });
    this.observed = { revision: next.value.revision, digest: next.digest };
    this.snapshot = next;
  }
}
