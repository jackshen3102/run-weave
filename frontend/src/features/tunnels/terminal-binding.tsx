import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu";
import { useTunnelStore } from "./store";
import { browserBindingErrorMessage } from "./presentation";

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
  const [installation, setInstallation] = useState<{
    apiBase: string;
    token: string;
    id: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const readyBindings = snapshot?.hosts
    .filter((h) => h.browser.state === "ready")
    .map((h) => `${h.hostId}:${h.installationId}:${h.bindingId}`).sort().join("|") ?? "";
  useEffect(() => {
    setInstallation(null);
    setSelected(null);
    if (!window.electronAPI || !token) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      try {
        const res = await fetch(`${apiBase}/api/remote/capabilities`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        if ([401, 403, 404].includes(res.status)) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const info = await res.json() as { installationId?: unknown };
        if (typeof info.installationId !== "string") return;
        if (!abort.signal.aborted) setInstallation({ apiBase, token, id: info.installationId });
      } catch {
        if (!abort.signal.aborted && attempt < 4)
          timer = setTimeout(() => void load(attempt + 1), Math.min(1000 * 2 ** attempt, 5000));
      }
    };
    void load(0);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [apiBase, token, readyBindings]);
  const installationId = installation?.apiBase === apiBase && installation.token === token
    ? installation.id : null;
  const candidates = installationId
    ? snapshot?.hosts.filter(
      (h) => h.browser.state === "ready" && h.installationId === installationId,
    ) ?? [] : [];
  const select = useMemoizedFn(async (hostId: string, targetTerminalId: string, isCurrent = () => true) => {
    if (!isCurrent() || !window.electronAPI?.selectTunnelBrowser) return;
    await window.electronAPI.selectTunnelBrowser(hostId, targetTerminalId);
    if (isCurrent()) setSelected(hostId);
  });
  const only = candidates.length === 1 ? candidates[0] : null;
  const onlyHostId = only?.hostId;
  const onlyBindingId = only?.bindingId;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bind = async (attempt: number) => {
      if (cancelled || !onlyHostId || !terminalId) return;
      try { await select(onlyHostId, terminalId, () => !cancelled); }
      catch (error) {
        if (cancelled) return;
        const permanent = /BROWSER_BINDING_CONFLICT|BROWSER_SCOPE_DENIED|NEEDS_AUTH|INVALID_TERMINAL/.test(String(error));
        if (!permanent && attempt < 4)
          timer = setTimeout(() => void bind(attempt + 1), Math.min(1000 * 2 ** attempt, 5000));
        else useTunnelStore.getState().setNotice(browserBindingErrorMessage(error));
      }
    };
    void bind(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiBase, token, onlyHostId, onlyBindingId, terminalId, select]);
  if (!terminalId || candidates.length < 2) return null;
  return (
    <>
      {candidates.map((h) => (
        <DropdownMenuItem key={h.hostId} onSelect={() => void select(h.hostId, terminalId)
          .catch((error) => useTunnelStore.getState().setNotice(browserBindingErrorMessage(error)))}>
          浏览器通道：
          {snapshot?.config.hosts.find((c) => c.id === h.hostId)?.name}
          {selected === h.hostId ? " ✓" : ""}
        </DropdownMenuItem>
      ))}
    </>
  );
}
