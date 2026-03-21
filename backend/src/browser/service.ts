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
  private context: BrowserContext | null = null;
  private readonly headless: boolean;
  private readonly profileDir: string;
  private readonly autoOpenDevtoolsForTabs: boolean;
  private readonly devtoolsEnabled: boolean;
  private readonly remoteDebuggingPort: number | null;

  constructor(options?: BrowserServiceOptions) {
    this.headless = options?.headless ?? true;
    this.profileDir =
      options?.profileDir?.trim() ||
      path.resolve(process.cwd(), ".browser-profile");
    this.autoOpenDevtoolsForTabs = options?.autoOpenDevtoolsForTabs ?? false;
    this.devtoolsEnabled = options?.devtoolsEnabled ?? false;
    this.remoteDebuggingPort =
      this.devtoolsEnabled && options?.remoteDebuggingPort
        ? options.remoteDebuggingPort
        : null;
  }

  private async getOrCreateContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    await mkdir(this.profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      args: buildLaunchArgs({
        autoOpenDevtoolsForTabs: this.autoOpenDevtoolsForTabs,
        remoteDebuggingPort: this.remoteDebuggingPort,
      }),
    });
    context.on("close", () => {
      if (this.context === context) {
        this.context = null;
      }
    });
    this.context = context;
    return context;
  }

  getRemoteDebuggingPort(): number | null {
    return this.remoteDebuggingPort;
  }

  isDevtoolsEnabled(): boolean {
    return this.devtoolsEnabled;
  }

  async createSession(targetUrl: string): Promise<BrowserSession> {
    const context = await this.getOrCreateContext();
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    return { context, page };
  }

  async destroySession(session: BrowserSession): Promise<void> {
    await session.page.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (!this.context) {
      return;
    }
    await this.context.close().catch(() => undefined);
    this.context = null;
  }
}
