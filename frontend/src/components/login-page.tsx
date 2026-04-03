import { useState } from "react";
import type { ConnectionConfig } from "../features/connection/types";
import { ConnectionSwitcher } from "./connection-switcher";
import { Button } from "./ui/button";
import { HttpError } from "../services/http";
import { login as loginWithPassword } from "../services/auth";
import { cleanupLegacyAuthStorage } from "../features/auth/storage";

interface LoginPageProps {
  apiBase: string;
  connectionId?: string;
  isElectron?: boolean;
  connections?: ConnectionConfig[];
  connectionName?: string;
  onSwitchConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onSuccess: (token: string) => void;
}

export function LoginPage({
  apiBase,
  connectionId,
  isElectron,
  connections = [],
  connectionName,
  onSwitchConnection,
  onOpenConnectionManager,
  onSuccess,
}: LoginPageProps) {
  cleanupLegacyAuthStorage();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const data = await loginWithPassword(apiBase, { username, password });
      onSuccess(data.token);
    } catch (loginError) {
      if (loginError instanceof HttpError && loginError.status === 401) {
        setError("Incorrect username or password.");
        return;
      }

      setError(String(loginError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(70,130,145,0.18),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(195,172,135,0.16),transparent_35%)]" />
      <section className="animate-fade-rise relative w-full max-w-md rounded-[2rem] border border-border/60 bg-card/82 p-7 shadow-[0_34px_120px_-72px_rgba(17,24,39,0.82)] backdrop-blur-xl sm:p-9">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
            Browser Viewer
          </p>
          {isElectron && connectionName && onSwitchConnection && onOpenConnectionManager ? (
            <ConnectionSwitcher
              connections={connections}
              activeConnectionId={connectionId ?? null}
              activeConnectionName={connectionName}
              onSelectConnection={onSwitchConnection}
              onOpenConnectionManager={onOpenConnectionManager}
              className="h-9 rounded-full border border-border/60 bg-background/60 px-3 text-[0.72rem] text-muted-foreground backdrop-blur"
            />
          ) : null}
        </div>

        <div className="mt-8 space-y-4">
          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
              htmlFor="username"
            >
              Username
            </label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
            />
          </div>

          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
              htmlFor="password"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void login();
                }
              }}
              className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}

          <Button
            className="mt-2 h-12 w-full rounded-full text-sm"
            onClick={() => void login()}
            disabled={loading}
          >
            {loading ? "Entering..." : "Continue"}
          </Button>
        </div>
      </section>
    </main>
  );
}
