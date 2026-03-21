import { chromium } from "playwright-extra";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

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
  private readonly headless: boolean;
  private readonly profileRootDir: string;
  private readonly autoOpenDevtoolsForTabs: boolean;
  private readonly devtoolsEnabled: boolean;
  private readonly remoteDebuggingPort: number | null;

  constructor(options?: BrowserServiceOptions) {
    this.headless = options?.headless ?? true;
    this.profileRootDir =
      options?.profileDir?.trim() ||
      path.resolve(process.cwd(), ".browser-profile");
    this.autoOpenDevtoolsForTabs = options?.autoOpenDevtoolsForTabs ?? false;
    this.devtoolsEnabled = options?.devtoolsEnabled ?? false;
    this.remoteDebuggingPort =
      this.devtoolsEnabled && options?.remoteDebuggingPort
        ? options.remoteDebuggingPort
        : null;
  }

  private getSessionProfileDir(sessionId: string): string {
    return path.join(this.profileRootDir, "sessions", sessionId);
  }

  private async getOrCreateContext(sessionId: string): Promise<BrowserContext> {
    const existingContext = this.contexts.get(sessionId);
    if (existingContext) {
      return existingContext;
    }

    const profileDir = this.getSessionProfileDir(sessionId);
    await mkdir(profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: this.headless,
      args: buildLaunchArgs({
        autoOpenDevtoolsForTabs: this.autoOpenDevtoolsForTabs,
        remoteDebuggingPort: this.remoteDebuggingPort,
      }),
    });
    context.on("close", () => {
      const current = this.contexts.get(sessionId);
      if (current === context) {
        this.contexts.delete(sessionId);
      }
    });
    this.contexts.set(sessionId, context);
    return context;
  }

  getRemoteDebuggingPort(): number | null {
    return this.remoteDebuggingPort;
  }

  isDevtoolsEnabled(): boolean {
    return this.devtoolsEnabled;
  }

  async createSession(
    sessionId: string,
    targetUrl: string,
  ): Promise<BrowserSession> {
    const context = await this.getOrCreateContext(sessionId);
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
  }

  async stop(): Promise<void> {
    const contexts = Array.from(this.contexts.values());
    this.contexts.clear();
    await Promise.all(
      contexts.map(async (context) => {
        await context.close().catch(() => undefined);
      }),
    );
  }
}
