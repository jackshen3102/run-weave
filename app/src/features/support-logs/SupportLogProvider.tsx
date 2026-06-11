import { Capacitor } from "@capacitor/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  installSupportLogRecorder,
  recordSupportLog,
  recordSupportLogToStore,
} from "./support-log-recorder";
import { createSupportLogStore } from "./support-log-store";
import type {
  SupportLogDefaultContext,
  SupportLogScope,
} from "./support-log-types";
import { SupportLogContext } from "./use-support-logs";

const APP_VERSION = "0.1.0";
const DEFAULT_SCOPE: SupportLogScope = { source: "unknown" };

function getApiBaseHost(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.location.host;
}

function createDefaultContext(): SupportLogDefaultContext {
  if (typeof window === "undefined") {
    return {
      appVersion: APP_VERSION,
      platform: Capacitor.getPlatform(),
    };
  }

  return {
    appVersion: APP_VERSION,
    platform: Capacitor.getPlatform(),
    route: window.location.pathname,
    apiBaseHost: getApiBaseHost(),
    online: navigator.onLine,
    userAgent: navigator.userAgent,
  };
}

function errorFields(error: Error): Record<string, unknown> {
  return {
    errorName: error.name,
    errorMessage: error.message,
    stack: error.stack?.split("\n").slice(0, 6).join("\n"),
  };
}

function unknownErrorFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return errorFields(reason);
  }
  return {
    errorName: typeof reason,
    errorMessage: String(reason),
  };
}

export function SupportLogProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef(createSupportLogStore());
  const [isOpen, setIsOpen] = useState(false);
  const [currentScope, setCurrentScope] =
    useState<SupportLogScope>(DEFAULT_SCOPE);

  useEffect(() => {
    const uninstall = installSupportLogRecorder({
      store: storeRef.current,
      resolveDefaultContext: createDefaultContext,
    });
    recordSupportLog("app.startup.ready");

    const handleError = (event: ErrorEvent) => {
      recordSupportLog(
        "app.error.unhandled",
        event.error instanceof Error
          ? errorFields(event.error)
          : {
              errorName: "ErrorEvent",
              errorMessage: event.message,
            },
        "error",
      );
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordSupportLog(
        "app.promise.unhandled_rejection",
        unknownErrorFields(event.reason),
        "error",
      );
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      uninstall();
    };
  }, []);

  const openSupportLogs = useCallback((scope: SupportLogScope) => {
    setCurrentScope(scope);
    setIsOpen(true);
    recordSupportLogToStore(storeRef.current, "support.sheet.opened", {
      scope,
    });
  }, []);

  const closeSupportLogs = useCallback(() => {
    setIsOpen(false);
  }, []);

  const clearSupportLogs = useCallback(async () => {
    await storeRef.current.clear();
    recordSupportLogToStore(storeRef.current, "support.logs.cleared");
  }, []);

  const contextValue = useMemo(
    () => ({
      clearSupportLogs,
      closeSupportLogs,
      currentScope,
      isOpen,
      openSupportLogs,
      store: storeRef.current,
    }),
    [
      clearSupportLogs,
      closeSupportLogs,
      currentScope,
      isOpen,
      openSupportLogs,
    ],
  );

  return (
    <SupportLogContext.Provider value={contextValue}>
      {children}
    </SupportLogContext.Provider>
  );
}
