import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  buildTabsSnapshot,
  buildSessionTabFaviconPath,
  inferTabFaviconUrl,
  resolveTabFaviconUrl,
} from "./tabs";

class FakePage {
  constructor(
    private readonly currentUrl: string,
    private readonly declaredFaviconHref: string | null = null,
  ) {}

  url(): string {
    return this.currentUrl;
  }

  async evaluate<T>(
    pageFunction: () => T,
  ): Promise<T | string | null> {
    void pageFunction;
    return this.declaredFaviconHref;
  }
}

describe("tabs snapshot", () => {
  it("infers a favicon url for http and https pages", () => {
    expect(inferTabFaviconUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(inferTabFaviconUrl("http://localhost:3000/viewer")).toBe(
      "http://localhost:3000/favicon.ico",
    );
  });

  it("returns null for pages without a web origin", () => {
    expect(inferTabFaviconUrl("about:blank")).toBeNull();
    expect(inferTabFaviconUrl("chrome://settings")).toBeNull();
  });

  it("includes inferred favicon urls in tabs snapshots", () => {
    const page = new FakePage("https://example.com/path") as unknown as Page;
    const pageToTabId = new WeakMap<Page, string>([[page, "tab-1"]]);

    expect(
      buildTabsSnapshot(
        "session-1",
        [page],
        pageToTabId,
        new Map([["tab-1", "Example"]]),
        new Map(),
        "tab-1",
      ),
    ).toEqual([
      {
        id: "tab-1",
        url: "https://example.com/path",
        title: "Example",
        active: true,
        faviconUrl: buildSessionTabFaviconPath("session-1", "tab-1"),
      },
    ]);
  });

  it("prefers a resolved favicon over the inferred fallback in tabs snapshots", () => {
    const page = new FakePage("https://example.com/path") as unknown as Page;
    const pageToTabId = new WeakMap<Page, string>([[page, "tab-1"]]);

    expect(
      buildTabsSnapshot(
        "session-1",
        [page],
        pageToTabId,
        new Map([["tab-1", "Example"]]),
        new Map([["tab-1", "https://cdn.example.com/icon.png"]]),
        "tab-1",
      ),
    ).toEqual([
      {
        id: "tab-1",
        url: "https://example.com/path",
        title: "Example",
        active: true,
        faviconUrl: buildSessionTabFaviconPath("session-1", "tab-1"),
      },
    ]);
  });

  it("resolves declared favicons before falling back", async () => {
    await expect(
      resolveTabFaviconUrl(
        new FakePage("https://example.com/docs", "/assets/icon-32.png") as unknown as Page,
      ),
    ).resolves.toBe("https://example.com/assets/icon-32.png");

    await expect(
      resolveTabFaviconUrl(
        new FakePage(
          "https://example.com/docs",
          "https://cdn.example.com/icon.png",
        ) as unknown as Page,
      ),
    ).resolves.toBe("https://cdn.example.com/icon.png");

    await expect(
      resolveTabFaviconUrl(
        new FakePage("https://example.com/docs", null) as unknown as Page,
      ),
    ).resolves.toBe("https://example.com/favicon.ico");
  });
});
