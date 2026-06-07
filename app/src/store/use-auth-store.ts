import { create } from "zustand";

import { resolveDefaultApiBase } from "../config/api-base";
import type { AppAuthSession } from "../services/auth";

const STORAGE_KEY = "runweave-app-auth-session";

type AuthState = AppAuthSession & {
  apiBase: string;
  isAuthenticated: boolean;
  setAuthenticated: (session: AppAuthSession) => void;
  clearSession: () => void;
};

function readStoredSession(): AppAuthSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.sessionId === "string"
    ) {
      return parsed as AppAuthSession;
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  return null;
}

function persistSession(session: AppAuthSession): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearStoredSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(STORAGE_KEY);
}

const storedSession = readStoredSession();
const defaultApiBase = resolveDefaultApiBase();

export const useAuthStore = create<AuthState>((set) => ({
  apiBase: defaultApiBase,
  accessToken: storedSession?.accessToken ?? "",
  refreshToken: storedSession?.refreshToken ?? "",
  expiresIn: storedSession?.expiresIn ?? 0,
  expiresAt: storedSession?.expiresAt ?? 0,
  sessionId: storedSession?.sessionId ?? "",
  isAuthenticated: Boolean(storedSession?.accessToken),
  setAuthenticated: (session) => {
    persistSession(session);
    set({ ...session, isAuthenticated: true });
  },
  clearSession: () => {
    clearStoredSession();
    set({
      apiBase: resolveDefaultApiBase(),
      accessToken: "",
      refreshToken: "",
      expiresIn: 0,
      expiresAt: 0,
      sessionId: "",
      isAuthenticated: false,
    });
  },
}));
