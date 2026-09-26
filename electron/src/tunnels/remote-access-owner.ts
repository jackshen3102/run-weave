import type {
  TunnelHostConfig,
  TunnelHostRuntime,
  TunnelState,
} from "@runweave/shared/tunnels";
import { desktopRuntime } from "../desktop/runtime-state.js";
import { RemoteAccessChannel } from "./remote-access.js";
export interface RemoteAccessOwner {
  config: TunnelHostConfig;
  runtime: TunnelHostRuntime;
  remote: RemoteAccessChannel | null;
  remoteBusy: boolean;
  remoteEpoch: number;
  remoteChecked: number;
}
const state = (
  state: TunnelState["state"],
  error: TunnelState["error"] = null,
): TunnelState => ({ state, error });
function failure(error: unknown): NonNullable<TunnelState["error"]> {
  const message = error instanceof Error ? error.message : "远程访问不可用";
  const [code, ...rest] = message.split(": ");
  return {
    code: code ?? "REMOTE_ACCESS_FAILED",
    message: rest.join(": ") || message,
  };
}
export async function stopRemoteAccess(h: RemoteAccessOwner) {
  ++h.remoteEpoch;
  const channel = h.remote;
  h.remote = null;
  h.remoteChecked = 0;
  h.runtime.remoteAccess = {
    ...state(h.config.remoteAccess?.enabled ? "waiting" : "disabled"),
    address: null,
    checkedAt: null,
  };
  await channel?.stop();
}
export async function refreshRemoteAccess(
  h: RemoteAccessOwner,
  current: () => boolean,
  publish: () => void,
) {
  const config = h.config.remoteAccess;
  if (!config?.enabled || h.remoteBusy || Date.now() - h.remoteChecked < 15000)
    return;
  h.remoteBusy = true;
  h.remoteChecked = Date.now();
  const epoch = h.remoteEpoch;
  const generation = h.runtime.generation;
  const active = () =>
    current() && h.runtime.generation === generation && h.remoteEpoch === epoch;
  let channel = h.remote;
  try {
    const base = desktopRuntime.packagedBackendState.backendUrl;
    if (!base)
      throw new Error(
        "LOCAL_BACKEND_UNAVAILABLE: 本机服务尚未就绪，请检查运行状态",
      );
    if (channel && channel.backendUrl !== base) {
      await channel.stop();
      h.remote = null;
      channel = null;
    }
    if (!active()) return;
    if (!channel) {
      if (!h.runtime.remoteAccess?.error)
        h.runtime.remoteAccess = {
          ...state("starting"),
          address: null,
          checkedAt: null,
        };
      channel = new RemoteAccessChannel(h.config.sshTarget, config, base);
      h.remote = channel;
      await channel.start();
    }
    if (!active()) {
      await channel.stop();
      return;
    }
    await channel.verify();
    if (active())
      h.runtime.remoteAccess = {
        ...state("ready"),
        address: channel.address,
        checkedAt: Date.now(),
      };
  } catch (error) {
    await channel?.stop();
    if (active()) {
      h.remote = null;
      const detail = failure(error);
      h.runtime.remoteAccess = {
        ...state(
          detail.code === "SSH_AUTH_FAILED" ? "needs_auth" : "failed",
          detail,
        ),
        address: null,
        checkedAt: Date.now(),
      };
      h.remoteChecked = Date.now();
    }
  } finally {
    h.remoteBusy = false;
    publish();
  }
}
