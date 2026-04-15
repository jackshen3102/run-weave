import { describe, expect, it, vi } from "vitest";
import {
  registerRunweavePwa,
  registerRunweavePwaAfterDomReady,
  shouldRegisterRunweavePwa,
  showRunweavePwaRefreshBanner,
  type RunweavePwaRegister,
} from "./registration";

describe("shouldRegisterRunweavePwa", () => {
  it("skips registration inside Electron", () => {
    expect(
      shouldRegisterRunweavePwa({
        isElectron: true,
        protocol: "https:",
        serviceWorkerSupported: true,
      }),
    ).toBe(false);
  });

  it("skips registration for the Electron custom protocol", () => {
    expect(
      shouldRegisterRunweavePwa({
        isElectron: false,
        protocol: "browser-viewer:",
        serviceWorkerSupported: true,
      }),
    ).toBe(false);
  });

  it("registers for a browser http or https origin when service workers are available", () => {
    expect(
      shouldRegisterRunweavePwa({
        isElectron: false,
        protocol: "http:",
        serviceWorkerSupported: true,
      }),
    ).toBe(true);
    expect(
      shouldRegisterRunweavePwa({
        isElectron: false,
        protocol: "https:",
        serviceWorkerSupported: true,
      }),
    ).toBe(true);
  });
});

describe("registerRunweavePwa", () => {
  it("does not call the PWA register hook when registration is unsupported", () => {
    const registerSW = vi.fn<RunweavePwaRegister>();

    const result = registerRunweavePwa({
      runtime: {
        isElectron: true,
        protocol: "https:",
        serviceWorkerSupported: true,
      },
      registerSW,
    });

    expect(result).toBeNull();
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("shows a non-blocking refresh prompt and applies the waiting service worker from its action", () => {
    const updateServiceWorker = vi.fn();
    let refreshAction: (() => void) | undefined;
    const promptRefresh = vi.fn((options: { onRefresh: () => void }) => {
      refreshAction = options.onRefresh;
    });
    let onNeedRefresh: (() => void) | undefined;
    const registerSW = vi.fn<RunweavePwaRegister>((options) => {
      onNeedRefresh = options.onNeedRefresh;
      return updateServiceWorker;
    });

    const result = registerRunweavePwa({
      runtime: {
        isElectron: false,
        protocol: "https:",
        serviceWorkerSupported: true,
      },
      registerSW,
      promptRefresh,
    });

    expect(result).toBe(updateServiceWorker);
    expect(registerSW).toHaveBeenCalledTimes(1);

    onNeedRefresh?.();

    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(promptRefresh).toHaveBeenCalledWith({
      message: "Runweave has an update ready. Refresh now?",
      onRefresh: expect.any(Function),
    });

    refreshAction?.();

    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });
});

describe("registerRunweavePwaAfterDomReady", () => {
  it("waits for DOMContentLoaded before registering while the document is still loading", () => {
    const registerSW = vi.fn<RunweavePwaRegister>(() => vi.fn());
    let domReadyListener: (() => void) | undefined;
    const currentDocument = {
      readyState: "loading",
      addEventListener: vi.fn(
        (
          eventName: string,
          listener: () => void,
          options?: AddEventListenerOptions,
        ) => {
          expect(eventName).toBe("DOMContentLoaded");
          expect(options).toEqual({ once: true });
          domReadyListener = listener;
        },
      ),
    };

    registerRunweavePwaAfterDomReady({
      registerSW,
      currentDocument: currentDocument as unknown as Document,
      runtime: {
        isElectron: false,
        protocol: "https:",
        serviceWorkerSupported: true,
      },
    });

    expect(registerSW).not.toHaveBeenCalled();

    domReadyListener?.();

    expect(registerSW).toHaveBeenCalledTimes(1);
  });
});

describe("showRunweavePwaRefreshBanner", () => {
  it("renders a refresh banner without using window.confirm", () => {
    const onRefresh = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm");

    showRunweavePwaRefreshBanner({
      message: "Runweave has an update ready. Refresh now?",
      onRefresh,
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    const banner = document.getElementById("runweave-pwa-refresh-banner");
    expect(banner?.textContent).toContain("Runweave has an update ready");

    const refreshButton = document.querySelector<HTMLButtonElement>(
      "#runweave-pwa-refresh-banner button",
    );
    refreshButton?.click();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.getElementById("runweave-pwa-refresh-banner")).toBeNull();
    confirmSpy.mockRestore();
  });
});
