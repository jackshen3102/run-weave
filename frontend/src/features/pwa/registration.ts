export interface RunweavePwaRuntime {
  isElectron: boolean;
  protocol: string;
  serviceWorkerSupported: boolean;
}

export interface RunweavePwaRegisterOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}

export type RunweavePwaUpdate = (reloadPage?: boolean) => void | Promise<void>;

export type RunweavePwaRegister = (
  options: RunweavePwaRegisterOptions,
) => RunweavePwaUpdate;

export interface RunweavePwaRefreshPromptOptions {
  message: string;
  onRefresh: () => void;
}

export type RunweavePwaRefreshPrompt = (
  options: RunweavePwaRefreshPromptOptions,
) => void;

interface RunweavePwaWindow {
  electronAPI?: {
    isElectron?: boolean;
  };
  location: {
    protocol: string;
  };
  navigator: Navigator;
}

interface RegisterRunweavePwaOptions {
  runtime?: RunweavePwaRuntime;
  registerSW: RunweavePwaRegister;
  promptRefresh?: RunweavePwaRefreshPrompt;
}

interface RegisterRunweavePwaAfterDomReadyOptions
  extends RegisterRunweavePwaOptions {
  currentDocument?: Document;
}

export const RUNWEAVE_PWA_REFRESH_MESSAGE =
  "Runweave has an update ready. Refresh now?";

function isBrowserProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export function shouldRegisterRunweavePwa(
  runtime: RunweavePwaRuntime,
): boolean {
  return (
    !runtime.isElectron &&
    runtime.serviceWorkerSupported &&
    isBrowserProtocol(runtime.protocol)
  );
}

export function resolveRunweavePwaRuntime(
  currentWindow: RunweavePwaWindow = window,
): RunweavePwaRuntime {
  return {
    isElectron: currentWindow.electronAPI?.isElectron === true,
    protocol: currentWindow.location.protocol,
    serviceWorkerSupported: "serviceWorker" in currentWindow.navigator,
  };
}

function applyButtonStyle(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    border: "1px solid rgba(255, 255, 255, 0.32)",
    borderRadius: "6px",
    background: "rgba(255, 255, 255, 0.12)",
    color: "#ffffff",
    cursor: "pointer",
    font: "inherit",
    padding: "6px 10px",
  });
}

export function showRunweavePwaRefreshBanner(
  { message, onRefresh }: RunweavePwaRefreshPromptOptions,
  currentDocument: Document = document,
): void {
  const { body } = currentDocument;
  if (!body) {
    return;
  }

  currentDocument
    .getElementById("runweave-pwa-refresh-banner")
    ?.remove();

  const banner = currentDocument.createElement("div");
  banner.id = "runweave-pwa-refresh-banner";
  banner.setAttribute("role", "status");
  Object.assign(banner.style, {
    alignItems: "center",
    background: "#123743",
    border: "1px solid rgba(255, 255, 255, 0.18)",
    borderRadius: "8px",
    bottom: "16px",
    boxShadow: "0 12px 36px rgba(0, 0, 0, 0.28)",
    color: "#ffffff",
    display: "flex",
    gap: "12px",
    left: "16px",
    maxWidth: "min(520px, calc(100vw - 32px))",
    padding: "12px",
    position: "fixed",
    right: "16px",
    zIndex: "2147483647",
  });

  const text = currentDocument.createElement("span");
  text.textContent = message;
  Object.assign(text.style, {
    flex: "1",
    fontSize: "14px",
    lineHeight: "20px",
  });

  const refreshButton = currentDocument.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh";
  applyButtonStyle(refreshButton);
  refreshButton.addEventListener("click", () => {
    banner.remove();
    onRefresh();
  });

  const laterButton = currentDocument.createElement("button");
  laterButton.type = "button";
  laterButton.textContent = "Later";
  applyButtonStyle(laterButton);
  laterButton.addEventListener("click", () => {
    banner.remove();
  });

  banner.append(text, refreshButton, laterButton);
  body.append(banner);
}

export function registerRunweavePwa({
  runtime = resolveRunweavePwaRuntime(),
  registerSW,
  promptRefresh = showRunweavePwaRefreshBanner,
}: RegisterRunweavePwaOptions): RunweavePwaUpdate | null {
  if (!shouldRegisterRunweavePwa(runtime)) {
    return null;
  }

  let applyUpdate: RunweavePwaUpdate = () => undefined;
  const updateServiceWorker = registerSW({
    immediate: false,
    onNeedRefresh() {
      promptRefresh({
        message: RUNWEAVE_PWA_REFRESH_MESSAGE,
        onRefresh() {
          void applyUpdate(true);
        },
      });
    },
  });

  applyUpdate = updateServiceWorker;
  return updateServiceWorker;
}

export function registerRunweavePwaAfterDomReady({
  currentDocument = document,
  ...options
}: RegisterRunweavePwaAfterDomReadyOptions): void {
  const register = (): void => {
    registerRunweavePwa(options);
  };

  if (currentDocument.readyState === "loading") {
    currentDocument.addEventListener("DOMContentLoaded", register, {
      once: true,
    });
    return;
  }

  register();
}
