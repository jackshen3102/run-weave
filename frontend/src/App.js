import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { ThemeToggle } from "./components/theme-toggle";
import { Button } from "./components/ui/button";
const API_BASE = "http://localhost:3000";
export default function App() {
    const [url, setUrl] = useState("https://example.com");
    const [loading, setLoading] = useState(false);
    const [session, setSession] = useState(null);
    const [error, setError] = useState(null);
    const createSession = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${API_BASE}/api/session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            });
            if (!response.ok) {
                throw new Error(`Create session failed: ${response.status}`);
            }
            const data = (await response.json());
            setSession(data);
        }
        catch (createError) {
            setError(String(createError));
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsxs("main", { className: "mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-10", children: [_jsxs("header", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-bold tracking-tight", children: "Browser Viewer Control Panel" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "React + Vite + shadcn/ui + Tailwind + Theme Toggle" })] }), _jsx(ThemeToggle, {})] }), _jsxs("section", { className: "rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur", children: [_jsx("label", { className: "mb-2 block text-sm font-medium", htmlFor: "target-url", children: "Target URL" }), _jsxs("div", { className: "flex flex-col gap-3 sm:flex-row", children: [_jsx("input", { id: "target-url", value: url, onChange: (event) => setUrl(event.target.value), className: "h-10 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2", placeholder: "https://example.com" }), _jsx(Button, { onClick: createSession, disabled: loading, children: loading ? "Creating..." : "Create Session" })] })] }), _jsxs("section", { className: "rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur", children: [error && _jsx("p", { className: "text-sm text-red-500", children: error }), !error && !session && _jsx("p", { className: "text-sm text-muted-foreground", children: "No active session yet." }), session && (_jsxs("div", { className: "space-y-2 text-sm", children: [_jsxs("p", { children: [_jsx("span", { className: "font-semibold", children: "Session:" }), " ", session.sessionId] }), _jsxs("p", { children: [_jsx("span", { className: "font-semibold", children: "Viewer URL:" }), " ", session.viewerUrl] }), _jsx("p", { className: "text-muted-foreground", children: "WebSocket viewer page will be implemented next." })] }))] })] }));
}
