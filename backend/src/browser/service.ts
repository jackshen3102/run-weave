import { chromium } from "playwright-extra";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { findAvailablePort } from "../server/listen";

const LOCAL_BYPASS_RULE = "127.0.0.1,localhost";
const WHISTLE_PROXY_SERVER = "http://127.0.0.1:8899";

export interface BrowserSession {
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

export interface BrowserSessionOptions {
  proxyEnabled: boolean;
  profilePath: string;
}

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
    args.push("--remote-debugging-address=0.0.0.0");
    args.push(
      "--remote-allow-origins=https://chrome-devtools-frontend.appspot.com",
    );
  }

  return args.length > 0 ? args : undefined;
}

export class BrowserService {
  private readonly contexts = new Map<string, BrowserContext>();
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

  private async getOrCreateContext(
    sessionId: string,
    options: BrowserSessionOptions,
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
        this.contexts.delete(sessionId);
        this.remoteDebuggingPorts.delete(sessionId);
      }
    });
    this.contexts.set(sessionId, context);
    return context;
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
    const context = await this.getOrCreateContext(sessionId, options);
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    return { context, page };
  }

  async restoreSession(
    sessionId: string,
    targetUrl: string,
    options: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    const context = await this.getOrCreateContext(sessionId, options);
    const persistedPage = context.pages().find(isRestorablePage);
    if (persistedPage) {
      return { context, page: persistedPage };
    }

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    return { context, page };
  }

  async destroySession(
    sessionId: string,
    session: BrowserSession,
  ): Promise<void> {
    await session.page.close().catch(() => undefined);
    const context = this.contexts.get(sessionId);
    if (!context || context !== session.context) {
      return;
    }

    await context.close().catch(() => undefined);
    this.contexts.delete(sessionId);
    this.remoteDebuggingPorts.delete(sessionId);
  }

  async stop(): Promise<void> {
    const contexts = Array.from(this.contexts.values());
    this.contexts.clear();
    this.remoteDebuggingPorts.clear();
    await Promise.all(
      contexts.map(async (context) => {
        await context.close().catch(() => undefined);
      }),
    );
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
