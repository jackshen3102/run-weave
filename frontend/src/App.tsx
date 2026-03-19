import { useState } from "react";
import { ThemeToggle } from "./components/theme-toggle";
import { Button } from "./components/ui/button";
import { ViewerPage } from "./components/viewer-page";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

interface SessionData {
  sessionId: string;
  viewerUrl: string;
}

export default function App() {
  const [url, setUrl] = useState("https://www.google.cn");
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchParams = new URLSearchParams(window.location.search);
  const viewerSessionId = searchParams.get("sessionId");

  if (viewerSessionId) {
    return <ViewerPage apiBase={API_BASE} sessionId={viewerSessionId} />;
  }

  const createSession = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    console.log("[viewer-fe] create session request", {
      apiBase: API_BASE,
      url,
    });

    try {
      const response = await fetch(`${API_BASE}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        console.log("[viewer-fe] create session non-ok response", {
          status: response.status,
        });
        throw new Error(`Create session failed: ${response.status}`);
      }

      const data = (await response.json()) as SessionData;
      setSession(data);
      console.log("[viewer-fe] create session success", data);
    } catch (createError) {
      setError(String(createError));
      console.log("[viewer-fe] create session failed", {
        error: String(createError),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Browser Viewer Control Panel
          </h1>
          <p className="text-sm text-muted-foreground">
            React + Vite + shadcn/ui + Tailwind + Theme Toggle
          </p>
        </div>
        <ThemeToggle />
      </header>

      <section className="rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur">
        <label className="mb-2 block text-sm font-medium" htmlFor="target-url">
          Target URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="target-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="h-10 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            placeholder="https://example.com"
          />
          <Button onClick={createSession} disabled={loading}>
            {loading ? "Creating..." : "Create Session"}
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {!error && !session && (
          <p className="text-sm text-muted-foreground">
            No active session yet.
          </p>
        )}
        {session && (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-semibold">Session:</span>{" "}
              {session.sessionId}
            </p>
            <p>
              <span className="font-semibold">Viewer URL:</span>{" "}
              {session.viewerUrl}
            </p>
            <div className="pt-2">
              <Button
                size="sm"
                onClick={() =>
                  window.open(
                    session.viewerUrl,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                Open Viewer
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
