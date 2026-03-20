import { useState } from "react";
import type { LoginResponse } from "@browser-viewer/shared";
import { Button } from "./ui/button";

interface LoginPageProps {
  apiBase: string;
  onSuccess: (token: string) => void;
}

export function LoginPage({ apiBase, onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          setError("用户名或密码错误");
          return;
        }
        throw new Error(`Login failed: ${response.status}`);
      }

      const data = (await response.json()) as LoginResponse;
      onSuccess(data.token);
    } catch (loginError) {
      setError(String(loginError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-4">
      <section className="w-full rounded-xl border border-border/80 bg-card/80 p-6 backdrop-blur">
        <h1 className="text-2xl font-bold tracking-tight">登录</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          请先登录后再使用 Browser Viewer。
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label
              className="mb-2 block text-sm font-medium"
              htmlFor="username"
            >
              用户名
            </label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            />
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-medium"
              htmlFor="password"
            >
              密码
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
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <Button
            className="w-full"
            onClick={() => void login()}
            disabled={loading}
          >
            {loading ? "登录中..." : "登录"}
          </Button>
        </div>
      </section>
    </main>
  );
}
