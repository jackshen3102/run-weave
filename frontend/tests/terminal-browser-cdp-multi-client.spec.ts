import { chromium, expect, test, type Browser } from "@playwright/test";

const endpoint =
  process.env.RUNWEAVE_DESKTOP_CDP_ENDPOINT ??
  process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;

function pagesFor(browser: Browser) {
  return browser.contexts().flatMap((context) => context.pages());
}

async function ensureAtLeastTwoPages(cdpEndpoint: string): Promise<void> {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    while (pagesFor(browser).length < 2) {
      await context.newPage();
    }
  } finally {
    await browser.close();
  }
}

test.describe("Terminal Browser CDP multi-client", () => {
  test.skip(
    !endpoint,
    "Set RUNWEAVE_DESKTOP_CDP_ENDPOINT to a live Runweave CDP endpoint.",
  );

  test("allows two Playwright clients to operate different pages concurrently", async () => {
    if (!endpoint) {
      throw new Error("RUNWEAVE_DESKTOP_CDP_ENDPOINT is required");
    }

    await ensureAtLeastTwoPages(endpoint);

    const browserA = await chromium.connectOverCDP(endpoint);
    const browserB = await chromium.connectOverCDP(endpoint);

    try {
      const pagesA = pagesFor(browserA);
      const pagesB = pagesFor(browserB);
      expect(pagesA.length).toBeGreaterThanOrEqual(2);
      expect(pagesB.length).toBeGreaterThanOrEqual(2);

      const pageA = pagesA[0]!;
      const pageB = pagesB[pagesB.length - 1]!;

      const results = await Promise.allSettled([
        pageA.evaluate(() => ({
          href: location.href,
          title: document.title,
          marker: "client-a",
        })),
        pageB.evaluate(() => ({
          href: location.href,
          title: document.title,
          marker: "client-b",
        })),
      ]);

      expect(results).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ marker: "client-a" }),
        }),
        expect.objectContaining({
          value: expect.objectContaining({ marker: "client-b" }),
        }),
      ]);
    } finally {
      await Promise.allSettled([browserA.close(), browserB.close()]);
    }
  });
});
