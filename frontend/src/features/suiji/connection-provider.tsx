import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMemoizedFn } from "ahooks";
import type {
  SuijiDesktopState,
  SuijiEnvironment,
  SuijiProfile,
} from "@runweave/shared/suiji/desktop";
import {
  SuijiClient,
  SuijiHttpError,
  suijiEndpoint,
} from "../../services/suiji";
import { SuijiDraftStore } from "./drafts";
import type { SuijiConnection } from "./connection-model";
import { loadAccounts, saveProfile, selectEnvironment } from "./accounts";

function useConnectionController() {
  const [accounts, setAccounts] = useState<SuijiDesktopState>();
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true),
    [message, setMessage] = useState("");
  const [needsLogin, setNeedsLogin] = useState(true);
  const [connection, setConnection] = useState<SuijiConnection>();
  const current = useRef<SuijiClient | undefined>(undefined);
  const alive = useRef(true);
  const generation = useRef(0);
  const fill = (profile: SuijiProfile) => {
    setEndpoint(profile.endpoint);
    setUsername(profile.username);
    setPassword(profile.password ?? "");
  };
  const connect = useMemoizedFn(
    async (state: SuijiDesktopState, login = false) => {
      const sequence = ++generation.current;
      current.current?.cancel();
      setConnection(undefined);
      setBusy(true);
      setMessage("");
      const environment = state.active;
      let profile = { ...state.profiles[environment] };
      let client: SuijiClient | undefined;
      try {
        if (login)
          profile = {
            endpoint: suijiEndpoint(endpoint),
            username: username.trim(),
            password,
          };
        setNeedsLogin(login || (!profile.session && !profile.password));
        if (
          !profile.endpoint ||
          (!login && !profile.session && !profile.password)
        )
          return;
        client = new SuijiClient(profile.endpoint, {
          session: profile.session,
          credentials: profile.password
            ? { username: profile.username, password: profile.password }
            : undefined,
          persist: async (session, forget) => {
            if (!alive.current || sequence !== generation.current)
              throw new DOMException("连接已切换", "AbortError");
            const next = {
              ...profile,
              session,
              ...(forget ? { password: undefined } : {}),
            };
            await saveProfile(environment, next);
            profile = next;
            if (alive.current && sequence === generation.current)
              setAccounts((value) =>
                value
                  ? {
                      ...value,
                      profiles: { ...value.profiles, [environment]: next },
                    }
                  : value,
              );
          },
        });
        current.current = client;
        const info = login
          ? await client.login(profile.username, profile.password!)
          : await client.restore();
        if (!alive.current || sequence !== generation.current) return;
        setConnection({
          client,
          info,
          store: new SuijiDraftStore(client.endpoint, info, environment),
        });
        fill(profile);
      } catch (error) {
        if (alive.current && sequence === generation.current) {
          if (error instanceof SuijiHttpError && error.status === 401) {
            setNeedsLogin(true);
            setPassword("");
          }
          setMessage(error instanceof Error ? error.message : "连接失败");
        }
      } finally {
        if (alive.current && sequence === generation.current) setBusy(false);
      }
    },
  );
  const initializing = useRef<Promise<void> | null>(null);
  const initialize = useMemoizedFn(async () => {
    if (initializing.current) return initializing.current;
    const job = (async () => {
      setBusy(true);
      setMessage("");
      try {
        const state = await loadAccounts();
        if (!alive.current) return;
        setAccounts(state);
        fill(state.profiles[state.active]);
        await connect(state);
      } catch (error) {
        if (alive.current) {
          setMessage(error instanceof Error ? error.message : "账户读取失败");
          setBusy(false);
        }
      }
    })();
    initializing.current = job;
    try {
      await job;
    } finally {
      if (initializing.current === job) initializing.current = null;
    }
  });
  const dispose = useMemoizedFn(() => {
    alive.current = false;
    ++generation.current;
    current.current?.cancel();
    initializing.current = null;
  });
  useEffect(() => {
    alive.current = true;
    return dispose;
  }, [initialize, dispose]);
  const switchEnvironment = useMemoizedFn(
    async (environment: SuijiEnvironment) => {
      if (!accounts || busy || environment === accounts.active) return;
      current.current?.cancel();
      ++generation.current;
      setConnection(undefined);
      setBusy(true);
      setMessage("");
      try {
        await selectEnvironment(environment);
        const state = await loadAccounts();
        setAccounts(state);
        fill(state.profiles[environment]);
        await connect(state);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "环境切换失败");
        setBusy(false);
      }
    },
  );
  const logout = useMemoizedFn(async () => {
    if (!accounts || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const old = current.current;
      setConnection(undefined);
      if (old) await old.logout();
      else await saveProfile(accounts.active, { endpoint, username });
      ++generation.current;
      current.current = undefined;
      setConnection(undefined);
      setPassword("");
      setNeedsLogin(true);
      const state = await loadAccounts();
      setAccounts(state);
      fill(state.profiles[state.active]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出失败");
    } finally {
      setBusy(false);
    }
  });
  const ensure = useMemoizedFn(() => {
    if (accounts || initializing.current)
      return initializing.current ?? Promise.resolve();
    return initialize();
  });
  const isCurrent = useMemoizedFn(
    (client: SuijiClient) =>
      alive.current && current.current === client && client.active,
  );
  const editAccount = useMemoizedFn(() => {
    current.current?.cancel();
    ++generation.current;
    setConnection(undefined);
    setNeedsLogin(true);
  });
  return {
    accounts,
    endpoint,
    setEndpoint,
    username,
    setUsername,
    password,
    setPassword,
    busy,
    message,
    connection,
    needsLogin,
    setNeedsLogin,
    ensure,
    initialize,
    connect,
    switchEnvironment,
    logout,
    editAccount,
    isCurrent,
  };
}
const SuijiConnectionContext = createContext<ReturnType<
  typeof useConnectionController
> | null>(null);
export function SuijiConnectionProvider({ children }: { children: ReactNode }) {
  const controller = useConnectionController();
  return (
    <SuijiConnectionContext.Provider value={controller}>
      {children}
    </SuijiConnectionContext.Provider>
  );
}
export function useSuijiConnection() {
  const value = useContext(SuijiConnectionContext);
  if (!value) throw new Error("SuijiConnectionProvider is missing");
  return value;
}
