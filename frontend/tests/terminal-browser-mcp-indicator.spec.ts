import { expect, test, type Page } from "@playwright/test";
import { shouldMarkTerminalBrowserMcpActivity } from "../../electron/src/terminal-browser-cdp-activity";

const STALE_ACTIVITY_UNTIL = Date.now() - 60_000;
const ACTIVE_ACTIVITY_UNTIL = Date.now() + 60_000;
const QUIET_PLAYWRIGHT_SETUP_COMMANDS = [
  "Page.enable",
  "Page.getFrameTree",
  "Log.enable",
  "Page.setLifecycleEventsEnabled",
  "Runtime.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Network.enable",
  "Target.setAutoAttach",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setEmulatedMedia",
  "Runtime.runIfWaitingForDebugger",
  "Page.createIsolatedWorld",
] as const;

async function renderTerminalBrowserTabs(
  page: Page,
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    cdpProxyAttached?: boolean;
    mcpActivityUntil?: number | null;
  }>,
  activeTabId = tabs[0]!.id,
): Promise<void> {
  await page.goto("/");
  await page.addScriptTag({
    type: "module",
    url: "/src/e2e/terminal-browser-tabs-harness.tsx",
  });
  await page.evaluate(
    ({ tabs: rawTabs, activeTabId: selectedTabId }) => {
      const harnessWindow = window as typeof window & {
        renderTerminalBrowserTabsHarness?: (
          tabs: typeof rawTabs,
          activeTabId?: string,
        ) => void;
      };
      harnessWindow.renderTerminalBrowserTabsHarness?.(rawTabs, selectedTabId);
    },
    { tabs, activeTabId },
  );
}

test("does not show MCP badge for a pre-existing tab that is only CDP-attached", async ({
  page,
}) => {
  await renderTerminalBrowserTabs(page, [
    {
      id: "github-tab",
      title: "Pull requests · jackshen3102/run-weave",
      url: "https://github.com/jackshen3102/run-weave/pulls",
      cdpProxyAttached: true,
      mcpActivityUntil: null,
    },
  ]);

  await expect(page.getByRole("tab")).toContainText("Pull requests");
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(0);
});

test("shows MCP badge only while the tab has recent MCP activity", async ({
  page,
}) => {
  await renderTerminalBrowserTabs(
    page,
    [
      {
        id: "attached-only",
        title: "Attached Existing Tab",
        url: "https://example.com/attached",
        cdpProxyAttached: true,
        mcpActivityUntil: null,
      },
      {
        id: "recently-operated",
        title: "Recently Operated Tab",
        url: "https://example.com/operated",
        cdpProxyAttached: true,
        mcpActivityUntil: ACTIVE_ACTIVITY_UNTIL,
      },
      {
        id: "expired-operation",
        title: "Expired Operation Tab",
        url: "https://example.com/expired",
        cdpProxyAttached: true,
        mcpActivityUntil: STALE_ACTIVITY_UNTIL,
      },
    ],
    "attached-only",
  );

  await expect(
    page.getByRole("tab", { name: /Attached Existing Tab/ }),
  ).toBeVisible();
  const operatedTab = page.getByRole("tab", {
    name: /Recently Operated Tab/,
  });
  await expect(operatedTab).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /Expired Operation Tab/ }),
  ).toBeVisible();
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(1);
  await expect(operatedTab.getByText("MCP", { exact: true })).toBeVisible();
});

test("keeps selected tab distinct from the MCP-operated tab", async ({
  page,
}) => {
  await renderTerminalBrowserTabs(
    page,
    [
      {
        id: "selected-tab",
        title: "Selected Human Tab",
        url: "https://example.com/human",
        cdpProxyAttached: true,
        mcpActivityUntil: null,
      },
      {
        id: "operated-background-tab",
        title: "Operated Background Tab",
        url: "https://example.com/background",
        cdpProxyAttached: true,
        mcpActivityUntil: ACTIVE_ACTIVITY_UNTIL,
      },
    ],
    "selected-tab",
  );

  const selectedTab = page.getByRole("tab", { name: /Selected Human Tab/ });
  const operatedTab = page.getByRole("tab", {
    name: /Operated Background Tab/,
  });
  await expect(selectedTab).toHaveAttribute("aria-selected", "true");
  await expect(selectedTab.getByText("MCP", { exact: true })).toHaveCount(0);
  await expect(operatedTab).toHaveAttribute("aria-selected", "false");
  await expect(operatedTab.getByText("MCP", { exact: true })).toBeVisible();
});

test("removes MCP badge after the activity window expires", async ({ page }) => {
  await renderTerminalBrowserTabs(page, [
    {
      id: "short-activity",
      title: "Short Activity Tab",
      url: "https://example.com/short",
      cdpProxyAttached: true,
      mcpActivityUntil: Date.now() + 1_500,
    },
  ]);

  await expect(page.getByText("MCP", { exact: true })).toBeVisible();
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(0, {
    timeout: 3_000,
  });
});

test("does not show a permanent MCP badge for a created tab without recent activity", async ({
  page,
}) => {
  await renderTerminalBrowserTabs(page, [
    {
      id: "mcp-created-but-idle",
      title: "MCP Created But Idle",
      url: "about:blank",
      cdpProxyAttached: true,
      mcpActivityUntil: null,
    },
  ]);

  await expect(
    page.getByRole("tab", { name: /MCP Created But Idle/ }),
  ).toBeVisible();
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(0);
});

test("closes the correct tab while the MCP badge is visible", async ({
  page,
}) => {
  await renderTerminalBrowserTabs(page, [
    {
      id: "close-while-active",
      title: "Close While Active",
      url: "https://example.com/close",
      cdpProxyAttached: true,
      mcpActivityUntil: ACTIVE_ACTIVITY_UNTIL,
    },
  ]);

  const operatedTab = page.getByRole("tab", { name: /Close While Active/ });
  await expect(operatedTab.getByText("MCP", { exact: true })).toBeVisible();
  await operatedTab.locator("xpath=..").getByLabel("Close browser tab").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.closedTerminalBrowserTabIds ?? []),
    )
    .toEqual(["close-while-active"]);
});

test("does not mark Playwright CDP setup commands as MCP activity", () => {
  for (const method of QUIET_PLAYWRIGHT_SETUP_COMMANDS) {
    expect(shouldMarkTerminalBrowserMcpActivity(method), method).toBe(false);
  }

  expect(shouldMarkTerminalBrowserMcpActivity("Page.navigate")).toBe(true);
  expect(shouldMarkTerminalBrowserMcpActivity("Input.dispatchMouseEvent")).toBe(
    true,
  );
  expect(shouldMarkTerminalBrowserMcpActivity("Runtime.evaluate")).toBe(true);
});
