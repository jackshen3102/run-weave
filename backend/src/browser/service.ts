import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export class BrowserService {
  private browser: Browser | null = null;

  async createSession(targetUrl: string): Promise<BrowserSession> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }

    const context = await this.browser.newContext();
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    return { context, page };
  }

  async destroySession(session: BrowserSession): Promise<void> {
    await session.page.close().catch(() => undefined);
    await session.context.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (!this.browser) {
      return;
    }
    await this.browser.close().catch(() => undefined);
    this.browser = null;
  }
}
