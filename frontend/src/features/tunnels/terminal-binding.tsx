import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu";
import { useTunnelStore } from "./store";

export function useTerminalBrowserTunnelBinding({
  apiBase,
  token,
  terminalId,
}: {
  apiBase: string;
  token: string | null;
  terminalId: string | null;
}) {
  const snapshot = useTunnelStore((state) => state.snapshot);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setInstallationId(null);
    setSelected(null);
    if (!window.electronAPI || !token) return;
    const abort = new AbortController();
    void fetch(`${apiBase}/api/remote/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const info = (await res.json()) as { installationId?: unknown };
        if (!abort.signal.aborted && typeof info.installationId === "string")
          setInstallationId(info.installationId);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [apiBase, token]);
  const candidates =
    snapshot?.hosts.filter(
      (h) => h.browser.state === "ready" && h.installationId === installationId,
    ) ?? [];
  const select = useMemoizedFn(async (hostId: string) => {
    if (!terminalId || !window.electronAPI?.selectTunnelBrowser) return;
    try {
      await window.electronAPI.selectTunnelBrowser(hostId, terminalId);
      setSelected(hostId);
    } catch (error) {
      useTunnelStore.getState().setNotice(String(error));
    }
  });
  const only = candidates.length === 1 ? candidates[0] : null;
  const onlyHostId = only?.hostId;
  const onlyBindingId = only?.bindingId;
  useEffect(() => {
    if (onlyHostId && terminalId) void select(onlyHostId);
  }, [onlyHostId, onlyBindingId, terminalId, select]);
  if (!terminalId || candidates.length < 2) return null;
  return (
    <>
      {candidates.map((h) => (
        <DropdownMenuItem key={h.hostId} onSelect={() => void select(h.hostId)}>
          浏览器通道：
          {snapshot?.config.hosts.find((c) => c.id === h.hostId)?.name}
          {selected === h.hostId ? " ✓" : ""}
        </DropdownMenuItem>
      ))}
    </>
  );
}
