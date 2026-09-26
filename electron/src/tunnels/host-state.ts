import type { TunnelHostConfig } from "@runweave/shared/tunnels";
import type { RemoteAccessOwner } from "./remote-access-owner.js";
import type { SshProcess } from "./ssh-process.js";
import type { BrowserChannel } from "./browser-channel.js";
import { childState } from "./runtime-state.js";
export interface Host extends RemoteAccessOwner {
  desired: boolean;
  control: SshProcess | null;
  forwards: Map<string, SshProcess>;
  forwardRetries: Map<string, { retryAt: number; failures: number }>;
  backends: Map<number, { process: SshProcess; url: string }>;
  channel: BrowserChannel | null;
  browserBusy: boolean;
  browserEpoch: number;
  endpointPending: Map<number, Promise<string>>;
  lastBrowserRefresh: number;
  busy: boolean;
  retryAt: number;
  failures: number;
}
export function createTunnelHost(config: TunnelHostConfig): Host {
  return {
    config,
    desired: false,
    control: null,
    forwards: new Map(),
    forwardRetries: new Map(),
    backends: new Map(),
    channel: null,
    remote: null,
    remoteBusy: false,
    remoteEpoch: 0,
    remoteChecked: 0,
    browserBusy: false,
    browserEpoch: 0,
    endpointPending: new Map(),
    lastBrowserRefresh: 0,
    busy: false,
    retryAt: 0,
    failures: 0,
    runtime: {
      hostId: config.id,
      generation: Date.now(),
      state: "disconnected",
      error: null,
      forwards: Object.fromEntries(
        config.forwards.map((f) => [
          f.id,
          childState(f.enabled ? "waiting" : "disabled"),
        ]),
      ),
      browser: childState(config.browser.enabled ? "waiting" : "disabled"),
      remoteAccess: {
        ...childState(config.remoteAccess?.enabled ? "waiting" : "disabled"),
        address: null,
        checkedAt: null,
      },
      installationId: null,
      bindingId: null,
      endpoints: {},
    },
  };
}
