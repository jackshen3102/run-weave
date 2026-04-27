import test from "node:test";
import assert from "node:assert/strict";

import {
  isBlockedCommand,
  classifyCdpCommand,
  validateNavigateParams,
  validateSetContentParams,
  validateKeyEvent,
  resolveCreateTargetWindowId,
  isCdpConnectionLimitReached,
  shouldSendTargetCreatedEvent,
  buildVersionResponse,
  buildTargetInfo,
  buildCdpError,
  buildCdpResult,
  buildCdpSessionResult,
  buildCdpSessionError,
} from "./terminal-browser-cdp-proxy-handler.js";

import {
  resolveCdpProxyPort,
} from "./terminal-browser-cdp-proxy-port.js";

test("isBlockedCommand blocks dangerous commands", () => {
  assert.equal(isBlockedCommand("Browser.close"), true);
  assert.equal(isBlockedCommand("Browser.crash"), true);
  assert.equal(isBlockedCommand("Target.setRemoteLocations"), true);
  assert.equal(isBlockedCommand("SystemInfo.getProcessInfo"), true);
  assert.equal(isBlockedCommand("Security.setIgnoreCertificateErrors"), true);
  assert.equal(isBlockedCommand("Network.clearBrowserCookies"), true);
  assert.equal(isBlockedCommand("Network.clearBrowserCache"), true);
  assert.equal(isBlockedCommand("Storage.clearDataForOrigin"), true);
});

test("isBlockedCommand allows safe commands", () => {
  assert.equal(isBlockedCommand("Page.navigate"), false);
  assert.equal(isBlockedCommand("Runtime.evaluate"), false);
  assert.equal(isBlockedCommand("Browser.getVersion"), false);
  assert.equal(isBlockedCommand("Target.getTargets"), false);
});

test("classifyCdpCommand classifies correctly", () => {
  assert.equal(classifyCdpCommand("Browser.close"), "blocked");
  assert.equal(classifyCdpCommand("Browser.getVersion"), "browser");
  assert.equal(classifyCdpCommand("Target.getTargets"), "target");
  assert.equal(classifyCdpCommand("Target.getTargetInfo"), "target");
  assert.equal(classifyCdpCommand("Target.setAutoAttach"), "target");
  assert.equal(classifyCdpCommand("Target.createTarget"), "target");
  assert.equal(classifyCdpCommand("Page.navigate"), "session");
  assert.equal(classifyCdpCommand("Runtime.evaluate"), "session");
  assert.equal(classifyCdpCommand("Input.dispatchMouseEvent"), "session");
});

test("validateNavigateParams allows http and https", () => {
  assert.deepEqual(validateNavigateParams({ url: "http://localhost:3000" }), { ok: true });
  assert.deepEqual(validateNavigateParams({ url: "https://example.com" }), { ok: true });
  assert.deepEqual(validateNavigateParams({}), { ok: true });
});

test("validateNavigateParams rejects dangerous protocols", () => {
  const fileResult = validateNavigateParams({ url: "file:///etc/passwd" });
  assert.equal(fileResult.ok, false);

  const chromeResult = validateNavigateParams({ url: "chrome://settings" });
  assert.equal(chromeResult.ok, false);

  const devtoolsResult = validateNavigateParams({ url: "devtools://devtools/bundled/inspector.html" });
  assert.equal(devtoolsResult.ok, false);

  const jsResult = validateNavigateParams({ url: "javascript:alert(1)" });
  assert.equal(jsResult.ok, false);
});

test("validateSetContentParams rejects dangerous references", () => {
  const fileResult = validateSetContentParams({ html: '<script src="file:///etc/passwd"></script>' });
  assert.equal(fileResult.ok, false);

  const jsResult = validateSetContentParams({ html: '<a href="javascript:alert(1)">click</a>' });
  assert.equal(jsResult.ok, false);

  assert.deepEqual(validateSetContentParams({ html: "<h1>hello</h1>" }), { ok: true });
  assert.deepEqual(validateSetContentParams({}), { ok: true });
});

test("validateKeyEvent blocks quit shortcuts", () => {
  const metaQ = validateKeyEvent({ key: "q", modifiers: 4 });
  assert.equal(metaQ.ok, false);

  const metaW = validateKeyEvent({ key: "W", modifiers: 4 });
  assert.equal(metaW.ok, false);

  const plainQ = validateKeyEvent({ key: "q", modifiers: 0 });
  assert.equal(plainQ.ok, true);

  const metaA = validateKeyEvent({ key: "a", modifiers: 4 });
  assert.equal(metaA.ok, true);
});

test("buildVersionResponse returns correct shape", () => {
  const result = buildVersionResponse("ws://127.0.0.1:9224/devtools/browser/test") as Record<string, unknown>;
  assert.equal(result.Browser, "Runweave/CDP-Proxy");
  assert.equal(result["Protocol-Version"], "1.3");
  assert.equal(result.webSocketDebuggerUrl, "ws://127.0.0.1:9224/devtools/browser/test");
});

test("buildTargetInfo returns correct shape", () => {
  const info = buildTargetInfo({
    targetId: "abc-123",
    url: "http://localhost:3000",
    title: "Test Page",
    attached: true,
  });
  assert.equal(info.targetId, "abc-123");
  assert.equal(info.type, "page");
  assert.equal(info.url, "http://localhost:3000");
  assert.equal(info.title, "Test Page");
  assert.equal(info.attached, true);
  assert.equal(info.browserContextId, "runweave-terminal-browser");
});

test("buildTargetInfo defaults attached to false", () => {
  const info = buildTargetInfo({
    targetId: "def-456",
    url: "http://localhost:5173",
    title: "",
  });
  assert.equal(info.attached, false);
});

test("resolveCreateTargetWindowId prefers the attached target window", () => {
  const targets = [
    { targetId: "login-tab", windowId: 1 },
    { targetId: "current-browser-tab", windowId: 2 },
  ];

  assert.equal(
    resolveCreateTargetWindowId(targets, ["current-browser-tab"], 9),
    2,
  );
});

test("resolveCreateTargetWindowId falls back to existing target before arbitrary windows", () => {
  assert.equal(
    resolveCreateTargetWindowId(
      [{ targetId: "current-browser-tab", windowId: 2 }],
      [],
      9,
    ),
    2,
  );
});

test("resolveCreateTargetWindowId falls back to Electron window when no browser target exists", () => {
  assert.equal(resolveCreateTargetWindowId([], [], 9), 9);
});

test("isCdpConnectionLimitReached rejects only at the configured limit", () => {
  assert.equal(isCdpConnectionLimitReached(7, 8), false);
  assert.equal(isCdpConnectionLimitReached(8, 8), true);
  assert.equal(isCdpConnectionLimitReached(9, 8), true);
});

test("shouldSendTargetCreatedEvent skips the createTarget initiator", () => {
  assert.equal(shouldSendTargetCreatedEvent(true, false), true);
  assert.equal(shouldSendTargetCreatedEvent(true, true), false);
  assert.equal(shouldSendTargetCreatedEvent(false, false), false);
});

test("buildCdpError returns correct shape", () => {
  const err = buildCdpError(1, -32601, "not found") as Record<string, unknown>;
  assert.equal(err.id, 1);
  assert.deepEqual(err.error, { code: -32601, message: "not found" });
});

test("buildCdpResult returns correct shape", () => {
  const res = buildCdpResult(2, { foo: "bar" }) as Record<string, unknown>;
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, { foo: "bar" });
});

test("buildCdpSessionResult includes sessionId", () => {
  const res = buildCdpSessionResult(3, "sess-1", { data: true }) as Record<string, unknown>;
  assert.equal(res.id, 3);
  assert.equal(res.sessionId, "sess-1");
  assert.deepEqual(res.result, { data: true });
});

test("buildCdpSessionError includes sessionId", () => {
  const err = buildCdpSessionError(4, "sess-2", -32000, "fail") as Record<string, unknown>;
  assert.equal(err.id, 4);
  assert.equal(err.sessionId, "sess-2");
  assert.deepEqual(err.error, { code: -32000, message: "fail" });
});

test("resolveCdpProxyPort returns default when env is empty", () => {
  const result = resolveCdpProxyPort({});
  assert.equal(result.port, 9224);
  assert.equal(result.strict, false);
});

test("resolveCdpProxyPort parses explicit env", () => {
  const result = resolveCdpProxyPort({
    BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT: "9300",
  });
  assert.equal(result.port, 9300);
  assert.equal(result.strict, true);
});

test("resolveCdpProxyPort rejects invalid port", () => {
  assert.throws(() => {
    resolveCdpProxyPort({
      BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT: "abc",
    });
  });
});

test("resolveCdpProxyPort rejects out-of-range port", () => {
  assert.throws(() => {
    resolveCdpProxyPort({
      BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT: "70000",
    });
  });
});
