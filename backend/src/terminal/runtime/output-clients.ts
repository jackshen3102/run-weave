import { RESUME_WINDOW_MS } from "./output-recovery";
import type { TerminalRecoveryReason } from "@runweave/shared/terminal/websocket";

interface ClientLease {
  sessionId: string;
  disconnectedAt?: number;
  supersede: () => void;
}

/** Memory-only continuity hints; session tickets remain the authorization gate. */
export class TerminalOutputClients {
  private readonly leases = new Map<string, ClientLease>();
  private expiryTimer?: NodeJS.Timeout;

  reason(
    sessionId: string,
    clientId: string,
  ): TerminalRecoveryReason | undefined {
    const lease = this.leases.get(this.key(sessionId, clientId));
    if (!lease) return "client_lease_missing";
    if (
      lease.disconnectedAt !== undefined &&
      performance.now() - lease.disconnectedAt > RESUME_WINDOW_MS
    )
      return "client_lease_expired";
    return undefined;
  }

  claim(
    sessionId: string,
    clientId: string,
    resume: boolean,
    supersede: () => void,
  ): () => void {
    const key = this.key(sessionId, clientId);
    const previous = this.leases.get(key);
    if (previous && previous.disconnectedAt === undefined && !resume)
      throw new Error("Recovery client already connected");
    const lease: ClientLease = { sessionId, supersede };
    // Install before closing the old socket: its delayed cleanup cannot release us.
    this.leases.set(key, lease);
    if (previous?.disconnectedAt === undefined) previous?.supersede();
    this.prune();
    return () => {
      if (this.leases.get(key) !== lease) return;
      lease.disconnectedAt = performance.now();
      lease.supersede = () => undefined;
      this.leases.delete(key);
      this.leases.set(key, lease);
      this.prune();
    };
  }

  forget(sessionId: string): void {
    for (const [key, lease] of this.leases)
      if (lease.sessionId === sessionId) this.leases.delete(key);
    this.prune();
  }

  private key(sessionId: string, clientId: string): string {
    return JSON.stringify([sessionId, clientId]);
  }

  private prune(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const now = performance.now();
    let total = 0;
    const counts = new Map<string, number>();
    // Newest first: keep at most 8 disconnected leases per runtime and 64 globally.
    let nextExpiry = Infinity;
    for (const [key, lease] of Array.from(this.leases).reverse()) {
      if (lease.disconnectedAt === undefined) continue;
      const count = counts.get(lease.sessionId) ?? 0;
      const remaining = RESUME_WINDOW_MS - (now - lease.disconnectedAt);
      if (remaining <= 0 || count >= 8 || total >= 64) {
        this.leases.delete(key);
        continue;
      }
      counts.set(lease.sessionId, count + 1);
      total++;
      nextExpiry = Math.min(nextExpiry, remaining);
    }
    if (Number.isFinite(nextExpiry)) {
      this.expiryTimer = setTimeout(
        () => this.prune(),
        Math.ceil(nextExpiry) + 1,
      );
      this.expiryTimer.unref();
    }
  }
}
