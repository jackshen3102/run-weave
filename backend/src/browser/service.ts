import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

chromium.use(StealthPlugin());

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export interface BrowserServiceOptions {
  headless?: boolean;
  profileDir?: string;
}

export class BrowserService {
  private context: BrowserContext | null = null;
  private readonly headless: boolean;
  private readonly profileDir: string;

  constructor(options?: BrowserServiceOptions) {
    this.headless = options?.headless ?? true;
    this.profileDir =
      options?.profileDir?.trim() || path.resolve(process.cwd(), ".browser-profile");
  }

  private async getOrCreateContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    await mkdir(this.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
    });
    context.on("close", () => {
      if (this.context === context) {
        this.context = null;
      }
    });
    this.context = context;
    return context;
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
