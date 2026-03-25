import { chromium } from "playwright-extra";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionHeaders } from "@browser-viewer/shared";
import type { Browser, BrowserContext, Page } from "playwright";
import { findAvailablePort } from "../server/listen";

const LOCAL_BYPASS_RULE = "127.0.0.1,localhost";
const WHISTLE_PROXY_SERVER = "http://127.0.0.1:8899";

export interface BrowserSession {
  type: "launch" | "connect-cdp";
  context: BrowserContext;
  page: Page;
}

export interface BrowserServiceOptions {
  headless?: boolean;
  profileDir?: string;
  autoOpenDevtoolsForTabs?: boolean;
  devtoolsEnabled?: boolean;
  remoteDebuggingPort?: number;
}

export interface LaunchBrowserSessionOptions {
  type: "launch";
  proxyEnabled: boolean;
  profilePath: string;
  headers: SessionHeaders;
}

export interface ConnectCdpBrowserSessionOptions {
  type: "connect-cdp";
  endpoint: string;
}

export type BrowserSessionOptions =
  | LaunchBrowserSessionOptions
  | ConnectCdpBrowserSessionOptions;

function isRestorablePage(page: Page): boolean {
  return page.url() !== "about:blank";
}

function buildLaunchArgs(options: {
  autoOpenDevtoolsForTabs: boolean;
  remoteDebuggingPort: number | null;
}): string[] | undefined {
  const args: string[] = [];

  if (options.autoOpenDevtoolsForTabs) {
    args.push("--auto-open-devtools-for-tabs");
  }
  if (options.remoteDebuggingPort !== null) {
    args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
    args.push("--remote-debugging-address=127.0.0.1");
    args.push(
      "--remote-allow-origins=https://chrome-devtools-frontend.appspot.com",
    );
  }

  return args.length > 0 ? args : undefined;
}

export class BrowserService {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly browsers = new Map<string, Browser>();
  private readonly remoteDebuggingPorts = new Map<string, number>();
  private readonly headless: boolean;
  private readonly profileRootDir: string;
  private readonly autoOpenDevtoolsForTabs: boolean;
  private readonly devtoolsEnabled: boolean;
  private readonly remoteDebuggingPortBase: number | null;

  constructor(options?: BrowserServiceOptions) {
    this.headless = options?.headless ?? true;
    this.profileRootDir =
      options?.profileDir?.trim() ||
      path.join(os.homedir(), ".browser-profile");
    this.autoOpenDevtoolsForTabs = options?.autoOpenDevtoolsForTabs ?? false;
    this.devtoolsEnabled = options?.devtoolsEnabled ?? false;
    this.remoteDebuggingPortBase =
      this.devtoolsEnabled && options?.remoteDebuggingPort
        ? options.remoteDebuggingPort
        : null;
  }

  getSessionProfileDir(sessionId: string): string {
    return path.join(this.profileRootDir, "sessions", sessionId);
  }

  private cleanupSessionResources(sessionId: string): void {
    this.contexts.delete(sessionId);
    this.browsers.delete(sessionId);
    this.remoteDebuggingPorts.delete(sessionId);
  }

  private async getOrCreateLaunchContext(
    sessionId: string,
    options: LaunchBrowserSessionOptions,
  ): Promise<BrowserContext> {
    const existingContext = this.contexts.get(sessionId);
    if (existingContext) {
      return existingContext;
    }

    const profileDir = options.profilePath;
    const remoteDebuggingPort =
      await this.allocateRemoteDebuggingPort(sessionId);
    await mkdir(profileDir, { recursive: true });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: this.headless,
        args: buildLaunchArgs({
          autoOpenDevtoolsForTabs: this.autoOpenDevtoolsForTabs,
          remoteDebuggingPort,
        }),
        extraHTTPHeaders: options.headers,
        proxy: options.proxyEnabled
          ? {
              bypass: LOCAL_BYPASS_RULE,
              server: WHISTLE_PROXY_SERVER,
            }
          : undefined,
      });
    } catch (error) {
      this.remoteDebuggingPorts.delete(sessionId);
      throw error;
    }

    context.on("close", () => {
      const current = this.contexts.get(sessionId);
      if (current === context) {
        this.cleanupSessionResources(sessionId);
      }
    });
    this.contexts.set(sessionId, context);
    return context;
  }

  private async connectToExistingBrowser(
    sessionId: string,
    endpoint: string,
  ): Promise<BrowserContext> {
    const existingContext = this.contexts.get(sessionId);
    if (existingContext) {
      return existingContext;
    }

    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error(
        `[viewer-be] no browser context available for CDP session ${sessionId}`,
      );
    }

    const remoteDebuggingPort = this.parseRemoteDebuggingPort(endpoint);
    if (remoteDebuggingPort != null) {
      this.remoteDebuggingPorts.set(sessionId, remoteDebuggingPort);
    }

    browser.on("disconnected", () => {
      const current = this.browsers.get(sessionId);
      if (current === browser) {
        this.cleanupSessionResources(sessionId);
      }
    });

    this.browsers.set(sessionId, browser);
    this.contexts.set(sessionId, context);
    return context;
  }

  private async createAttachedSession(
    sessionId: string,
    targetUrl: string,
    options: ConnectCdpBrowserSessionOptions,
  ): Promise<BrowserSession> {
    const context = await this.connectToExistingBrowser(
      sessionId,
      options.endpoint,
    );
    const page =
      context.pages().find(isRestorablePage) ?? (await context.newPage());
    if (page.url() === "about:blank") {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    return {
      type: "connect-cdp",
      context,
      page,
    };
  }

  getRemoteDebuggingPort(sessionId: string): number | null {
    return this.remoteDebuggingPorts.get(sessionId) ?? null;
  }

  isDevtoolsEnabled(): boolean {
    return this.devtoolsEnabled;
  }

  async createSession(
    sessionId: string,
    targetUrl: string,
    options: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    if (options.type === "connect-cdp") {
      return this.createAttachedSession(sessionId, targetUrl, options);
    }

    const context = await this.getOrCreateLaunchContext(sessionId, options);
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    return { type: "launch", context, page };
  }

  async restoreSession(
    sessionId: string,
    targetUrl: string,
    options: LaunchBrowserSessionOptions,
  ): Promise<BrowserSession> {
    const context = await this.getOrCreateLaunchContext(sessionId, options);
    const persistedPage = context.pages().find(isRestorablePage);
    if (persistedPage) {
      return { type: "launch", context, page: persistedPage };
    }

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    return { type: "launch", context, page };
  }

  async destroySession(
    sessionId: string,
    session: BrowserSession,
  ): Promise<void> {
    if (session.type === "connect-cdp") {
      const browser = this.browsers.get(sessionId);
      this.cleanupSessionResources(sessionId);
      await browser?.close().catch(() => undefined);
      return;
    }

    await session.page.close().catch(() => undefined);
    const context = this.contexts.get(sessionId);
    if (!context || context !== session.context) {
      return;
    }

    await context.close().catch(() => undefined);
    this.cleanupSessionResources(sessionId);
  }

  async stop(): Promise<void> {
    const contexts = Array.from(this.contexts.entries())
      .filter(([sessionId]) => !this.browsers.has(sessionId))
      .map(([, context]) => context);
    const browsers = Array.from(this.browsers.values());
    this.contexts.clear();
    this.browsers.clear();
    this.remoteDebuggingPorts.clear();
    await Promise.all(
      contexts.map(async (context) => {
        await context.close().catch(() => undefined);
      }),
    );
    await Promise.all(
      browsers.map(async (browser) => {
        await browser.close().catch(() => undefined);
      }),
    );
  }

  private parseRemoteDebuggingPort(endpoint: string): number | null {
    try {
      const url = new URL(endpoint);
      if (url.port) {
        return Number(url.port);
      }

      if (url.protocol === "http:" || url.protocol === "ws:") {
        return 80;
      }
      if (url.protocol === "https:" || url.protocol === "wss:") {
        return 443;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async allocateRemoteDebuggingPort(
    sessionId: string,
  ): Promise<number | null> {
    if (!this.devtoolsEnabled || this.remoteDebuggingPortBase == null) {
      return null;
    }

    const existingPort = this.remoteDebuggingPorts.get(sessionId);
    if (existingPort != null) {
      return existingPort;
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidatePort = this.remoteDebuggingPortBase + attempt;
      if (
        Array.from(this.remoteDebuggingPorts.values()).includes(candidatePort)
      ) {
        continue;
      }

      try {
        const port = await findAvailablePort(candidatePort, {
          host: "127.0.0.1",
          maxAttempts: 1,
        });
        this.remoteDebuggingPorts.set(sessionId, port);
        return port;
      } catch {
        continue;
      }
    }

    throw new Error(
      `[viewer-be] failed to allocate remote debugging port for session ${sessionId}`,
    );
  }
}
