import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { MobileLoginQrV1, MobileLoginStatus } from "@runweave/shared/mobile-login";
import { cancelMobileLogin, createMobileLogin, decideMobileLogin, getMobileLogin, MobileLoginHttpError } from "../../services/mobile-login";
import type { ConnectionConfig } from "../connection/types";
import { mobileLoginAddresses } from "./address";

const terminalStates = ["completed", "cancelled", "rejected", "expired", "unconfirmed", "failed"];
const message = (error: unknown) => error instanceof MobileLoginHttpError ? error.message : "连接暂时失败，请重试。";
interface Attempt { qr: MobileLoginQrV1; generation: number }

export function useMobileLogin(connection: ConnectionConfig, token: string) {
  const [opened, setOpened] = useState(false);
  const [connectionName, setConnectionName] = useState(connection.name);
  const openedConnection = useRef(connection);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [qr, setQr] = useState<MobileLoginQrV1 | null>(null);
  const [status, setStatus] = useState<MobileLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const attempt = useRef<Attempt | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const createQueue = useRef(Promise.resolve());
  const deciding = useRef(false);
  const cancel = useMemoizedFn((value: Attempt | null) => {
    if (value) void cancelMobileLogin(connection.url, tokenRef.current, value.qr.requestId).catch(() => undefined);
  });

  const close = useMemoizedFn(() => {
    generation.current += 1;
    cancel(attempt.current);
    attempt.current = null;
    setOpened(false); setQr(null); setStatus(null); setBusy(false);
  });

  const generate = useMemoizedFn((baseUrl: string) => {
    const epoch = ++generation.current;
    cancel(attempt.current); attempt.current = null;
    setAddress(baseUrl); setQr(null); setStatus(null); setError(null); setBusy(true);
    // Serialize creation, including late responses, so an older POST cannot replace a newer code.
    createQueue.current = createQueue.current.catch(() => undefined).then(async () => {
      if (epoch !== generation.current) return;
      try {
        const value = await createMobileLogin(connection.url, tokenRef.current, { baseUrl, connectionName: openedConnection.current.name });
        const next = { qr: value, generation: epoch };
        if (epoch !== generation.current) { cancel(next); return; }
        attempt.current = next;
        setQr(value); setStatus({ requestId: value.requestId, state: "waiting_scan", expiresAt: value.expiresAt });
      } catch (failure) { if (epoch === generation.current) setError(message(failure)); }
      finally { if (epoch === generation.current) setBusy(false); }
    });
  });

  const open = useMemoizedFn(async () => {
    const epoch = ++generation.current;
    openedConnection.current = { ...connection };
    setConnectionName(connection.name);
    setOpened(true); setBusy(true); setError(null); setQr(null); setStatus(null);
    try {
      const values = await mobileLoginAddresses(connection);
      if (epoch !== generation.current) return;
      setAddresses(values); generate(values[0]!);
    } catch (failure) {
      if (epoch === generation.current) { setBusy(false); setError(failure instanceof Error ? failure.message : message(failure)); }
    }
  });

  const decide = useMemoizedFn(async (decision: "approve" | "reject") => {
    const current = attempt.current;
    if (!current || !status?.claimId || status.state !== "pending_approval" || deciding.current) return;
    deciding.current = true; setBusy(true); setError(null);
    try {
      const value = await decideMobileLogin(connection.url, tokenRef.current, current.qr.requestId, { claimId: status.claimId, decision });
      if (current.generation === generation.current) setStatus(value);
    } catch (failure) {
      if (current.generation === generation.current) {
        setError(`${message(failure)} 正在核对电脑端状态。`);
        // Polling resolves an uncertain decision; never silently create a replacement request.
      }
    } finally {
      deciding.current = false;
      if (current.generation === generation.current) setBusy(false);
    }
  });

  useEffect(() => {
    if (!opened || !qr) return;
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = generation.current;
    const poll = async () => {
      if (stopped || reading || document.hidden) return;
      if (deciding.current) { timer = setTimeout(() => void poll(), 1000); return; }
      reading = true;
      let delay = 1000;
      let done = false;
      try {
        const value = await getMobileLogin(connection.url, tokenRef.current, qr.requestId);
        if (!stopped && epoch === generation.current) {
          setStatus(value); setError(null); done = terminalStates.includes(value.state);
        }
      } catch (failure) {
        if (!stopped && epoch === generation.current) {
          setError(message(failure));
          if (failure instanceof MobileLoginHttpError) {
            delay = Math.max(1000, failure.retryAfter * 1000);
            done = [401, 404, 410].includes(failure.status);
          }
        }
      } finally {
        reading = false;
        if (!stopped && !done) timer = setTimeout(() => void poll(), delay);
      }
    };
    const tick = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { stopped = true; clearTimeout(timer); clearInterval(tick); document.removeEventListener("visibilitychange", visibility); };
  }, [opened, qr, connection.url]);

  useEffect(() => {
    const leaving = () => { generation.current += 1; cancel(attempt.current); attempt.current = null; };
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); leaving(); };
  }, [cancel]);
  return { opened, open, close, connectionName, addresses, address, generate, qr, status, error, busy, decide,
    seconds: qr ? Math.max(0, Math.ceil((Date.parse(qr.expiresAt) - now) / 1000)) : 0 };
}
