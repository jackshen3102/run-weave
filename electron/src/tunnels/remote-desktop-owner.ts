import type { TunnelHostConfig, TunnelHostRuntime } from "@runweave/shared/tunnels";
import { RemoteDesktopChannel } from "./remote-desktop-channel.js";
import { getLocalRemoteDesktopInfo } from "./local-remote-desktop.js";
import { childState, failure } from "./runtime-state.js";

export interface RemoteDesktopOwner {
  config: TunnelHostConfig;
  runtime: TunnelHostRuntime;
  remoteDesktop: RemoteDesktopChannel | null;
  remoteDesktopBusy: boolean;
  remoteDesktopEpoch: number;
  remoteDesktopChecked: number;
  remoteDesktopTimeouts: number;
}

export async function stopRemoteDesktop(h: RemoteDesktopOwner) {
  ++h.remoteDesktopEpoch;
  const channel = h.remoteDesktop;
  h.remoteDesktop = null;
  h.remoteDesktopChecked = 0;
  h.remoteDesktopTimeouts = 0;
  h.runtime.remoteDesktop = {
    ...childState(h.config.remoteDesktop?.enabled ? "waiting" : "disabled"),
    address: null, checkedAt: null,
  };
  await channel?.stop();
}

export async function refreshRemoteDesktop(h: RemoteDesktopOwner, current: () => boolean, publish: () => void) {
  let config = h.config.remoteDesktop;
  if (!config?.enabled || h.remoteDesktopBusy || Date.now() - h.remoteDesktopChecked < 15_000) return;
  h.remoteDesktopBusy = true;
  h.remoteDesktopChecked = Date.now();
  const epoch = h.remoteDesktopEpoch;
  const generation = h.runtime.generation;
  const active = () => current() && h.remoteDesktopEpoch === epoch && h.runtime.generation === generation;
  let channel = h.remoteDesktop;
  try {
    if (config.autoDetectLocalHost) {
      const local = await getLocalRemoteDesktopInfo();
      if (!active()) return;
      if (local.certificateFingerprint !== config.certificateFingerprint)
        throw new Error("REMOTE_DESKTOP_IDENTITY_MISMATCH: 本机 RemoteDesk 身份已改变，请核对并重新配对；不会自动替换原证书指纹。");
      config = { ...config, ...local };
      if (channel && !channel.usesLocalHost(local)) {
        await channel.stop();
        if (!active()) return;
        channel = null;
        h.remoteDesktop = null;
      }
    }
    if (!channel) {
      h.runtime.remoteDesktop = { ...childState("starting"), address: null, checkedAt: null };
      publish();
      channel = new RemoteDesktopChannel(h.config.sshTarget, config);
      h.remoteDesktop = channel;
      await channel.start();
    }
    if (!active()) { await channel.stop(); return; }
    await channel.verify();
    if (active()) {
      h.remoteDesktopTimeouts = 0;
      h.runtime.remoteDesktop = { ...childState("ready"), address: channel.address, checkedAt: Date.now() };
    }
  } catch (error) {
    const detail = failure(error);
    if (active() && detail.code === "REMOTE_DESKTOP_TIMEOUT" && channel?.alive &&
      h.runtime.remoteDesktop?.address === channel.address && ++h.remoteDesktopTimeouts < 3) {
      h.runtime.remoteDesktop = { ...childState("failed", detail), address: channel.address, checkedAt: Date.now() };
      return;
    }
    await channel?.stop();
    if (active()) {
      h.remoteDesktop = null;
      h.remoteDesktopTimeouts = 0;
      h.remoteDesktopChecked = Date.now();
      h.runtime.remoteDesktop = {
        ...childState(detail.code === "SSH_AUTH_FAILED" ? "needs_auth" : "failed", detail),
        address: null, checkedAt: Date.now(),
      };
    }
  } finally { h.remoteDesktopBusy = false; publish(); }
}
