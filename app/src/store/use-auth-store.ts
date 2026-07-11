import { create } from "zustand";

import type { AppAuthSession } from "../features/auth/types";
import { getAppAuthCredentialStore } from "./app-auth-credential-store";

type AuthState = AppAuthSession & {
  activeConnectionId: string | null;
  isAuthenticated: boolean;
  isSessionLoading: boolean;
  sessionError: string | null;
  loadSessionForConnection: (connectionId: string | null) => Promise<void>;
  setAuthenticated: (
    connectionId: string,
    session: AppAuthSession,
  ) => Promise<void>;
  clearSession: (connectionId?: string | null) => Promise<void>;
};

function emptySessionState() {
  return {
    accessToken: "",
    refreshToken: "",
    expiresIn: 0,
    expiresAt: 0,
    sessionId: "",
    isAuthenticated: false,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...emptySessionState(),
  activeConnectionId: null,
  isSessionLoading: false,
  sessionError: null,

  loadSessionForConnection: async (connectionId) => {
    if (!connectionId) {
      set({
        ...emptySessionState(),
        activeConnectionId: null,
        isSessionLoading: false,
        sessionError: null,
      });
      return;
    }

    set({
      ...emptySessionState(),
      activeConnectionId: connectionId,
      isSessionLoading: true,
      sessionError: null,
    });

    try {
      const session =
        await getAppAuthCredentialStore().loadSession(connectionId);
      if (get().activeConnectionId !== connectionId) {
        return;
      }
      set({
        ...(session ?? emptySessionState()),
        activeConnectionId: connectionId,
        isAuthenticated: Boolean(session?.accessToken),
        isSessionLoading: false,
        sessionError: null,
      });
    } catch (error) {
      if (get().activeConnectionId !== connectionId) {
        return;
      }
      set({
        ...emptySessionState(),
        activeConnectionId: connectionId,
        isSessionLoading: false,
        sessionError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setAuthenticated: async (connectionId, session) => {
    await getAppAuthCredentialStore().saveSession(connectionId, session);
    if (get().activeConnectionId !== connectionId) {
      return;
    }
    set({
      ...session,
      activeConnectionId: connectionId,
      isAuthenticated: true,
      isSessionLoading: false,
      sessionError: null,
    });
  },

  clearSession: async (connectionId) => {
    const targetConnectionId = connectionId ?? get().activeConnectionId;
    if (targetConnectionId) {
      await getAppAuthCredentialStore().clearSession(targetConnectionId);
    }
    if (targetConnectionId && get().activeConnectionId !== targetConnectionId) {
      return;
    }
    set({
      ...emptySessionState(),
      activeConnectionId: targetConnectionId ?? null,
      isSessionLoading: false,
      sessionError: null,
    });
  },
}));
