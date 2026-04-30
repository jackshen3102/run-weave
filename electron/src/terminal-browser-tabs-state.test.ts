import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTerminalBrowserPersistedState,
  normalizeTerminalBrowserUrlForStorage,
  selectTerminalBrowserTabsForRestore,
  type TerminalBrowserPersistedTabRecord,
} from "./terminal-browser-tabs-state.js";

test("normalizes persisted terminal browser tabs", () => {
  const state = normalizeTerminalBrowserPersistedState({
    activeTabId: "tab-2",
    tabs: [
      { id: "tab-1", url: "http://localhost:5173", title: "Local" },
      { id: "tab-2", url: "https://example.com/path", title: "Example" },
      { id: "tab-3", url: "file:///etc/passwd", title: "Unsafe" },
      { id: "tab-2", url: "https://duplicate.example", title: "Duplicate" },
      { id: "tab-4", url: "https://4.example", title: "" },
      { id: "tab-5", url: "https://5.example", title: "" },
      { id: "tab-6", url: "https://6.example", title: "" },
    ],
  });

  assert.deepEqual(
    state.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })),
    [
      { id: "tab-1", url: "http://localhost:5173/", title: "Local" },
      { id: "tab-2", url: "https://example.com/path", title: "Example" },
      { id: "tab-4", url: "https://4.example/", title: "" },
      { id: "tab-5", url: "https://5.example/", title: "" },
      { id: "tab-6", url: "https://6.example/", title: "" },
    ],
  );
  assert.equal(state.activeTabId, "tab-2");
});

test("selects restored terminal browser tabs without dropping active tab", () => {
  const tabs: TerminalBrowserPersistedTabRecord[] = [
    { id: "tab-1", url: "https://1.example", title: "", lastActiveAt: 10 },
    { id: "tab-2", url: "https://2.example", title: "", lastActiveAt: 20 },
    { id: "tab-3", url: "https://3.example", title: "", lastActiveAt: 30 },
    { id: "tab-4", url: "https://4.example", title: "", lastActiveAt: 40 },
    { id: "tab-5", url: "https://5.example", title: "", lastActiveAt: 50 },
    { id: "tab-6", url: "https://6.example", title: "", lastActiveAt: 60 },
  ];

  const restoredTabs = selectTerminalBrowserTabsForRestore(tabs, "tab-1", 5);

  assert.deepEqual(
    restoredTabs.map((tab) => tab.id),
    ["tab-1", "tab-3", "tab-4", "tab-5", "tab-6"],
  );
});

test("validates terminal browser persisted urls", () => {
  assert.equal(
    normalizeTerminalBrowserUrlForStorage("https://example.com/a"),
    "https://example.com/a",
  );
  assert.equal(normalizeTerminalBrowserUrlForStorage("about:blank"), "about:blank");
  assert.equal(normalizeTerminalBrowserUrlForStorage("javascript:alert(1)"), null);
});
