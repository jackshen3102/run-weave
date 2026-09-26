import assert from "node:assert/strict";
import {
  AppBuildError,
  describeDesktopVerificationState,
  DesktopVerificationError,
  resolveDesktopVerificationResult,
} from "./operations.mjs";

export const verificationCases = [
  {
    name: "desktop verification accepts renderer route changes for the expected app version",
    run() {
      const status = {
        app: {
          path: "/Applications/Runweave.app",
          pid: 1234,
          version: "0.155.0",
        },
        appServer: { home: "/tmp/app-server" },
        backend: { available: true },
        cdp: {
          desktop: {
            endpoint: "http://127.0.0.1:9223",
            pid: 1234,
          },
        },
        sourceRevision: "revision",
        window: {
          url: "runweave://app/index.html",
          visible: true,
        },
      };
      const targets = [
        { type: "page", url: "https://example.com" },
        { type: "page", url: "runweave://app/terminal/65d39c46" },
      ];
      const input = {
        appPath: "/Applications/Runweave.app",
        endpoint: "http://127.0.0.1:9223",
        expectedAppVersion: "0.155.0",
        status,
        statusPath: "/tmp/desktop-verification.json",
        targets,
      };

      assert.equal(
        resolveDesktopVerificationResult(input)?.pageUrl,
        "runweave://app/terminal/65d39c46",
      );
      assert.equal(
        resolveDesktopVerificationResult({
          ...input,
          expectedAppVersion: "0.156.0",
        }),
        null,
      );
    },
  },
  {
    name: "desktop verification diagnostics distinguish missing status from CDP and identity failures",
    run() {
      const missingStatus = describeDesktopVerificationState({
        appPath: "/Applications/Runweave.app",
        cdpError: null,
        endpoint: "http://127.0.0.1:9223",
        expectedAppVersion: "0.155.0",
        runningAppLines: [
          "1234 /Applications/Runweave.app/Contents/MacOS/Runweave",
        ],
        status: null,
        statusPath: "/tmp/desktop-verification.json",
        targets: null,
      });
      assert.equal(missingStatus.appRunning, true);
      assert.equal(missingStatus.statusPathExists, false);
      assert.equal(missingStatus.targetCount, null);

      const mismatchedStatus = describeDesktopVerificationState({
        appPath: "/Applications/Runweave.app",
        cdpError: "fetch failed",
        endpoint: "http://127.0.0.1:9223",
        expectedAppVersion: "0.155.0",
        runningAppLines: [],
        status: {
          app: { path: "/tmp/Runweave.app", pid: 1234, version: "0.154.0" },
          window: { visible: false },
        },
        statusPath: "/tmp/desktop-verification.json",
        targets: [{ type: "page", url: "https://example.com" }],
      });
      assert.deepEqual(mismatchedStatus, {
        appPath: "/Applications/Runweave.app",
        appRunning: false,
        cdpError: "fetch failed",
        endpoint: "http://127.0.0.1:9223",
        expectedAppVersion: "0.155.0",
        pageUrl: null,
        statusAppPath: "/tmp/Runweave.app",
        statusAppVersion: "0.154.0",
        statusPath: "/tmp/desktop-verification.json",
        statusPathExists: true,
        statusPid: 1234,
        statusWindowVisible: false,
        targetCount: 1,
      });
      assert.match(
        new DesktopVerificationError(missingStatus).message,
        /"statusPathExists":false/,
      );
    },
  },
  {
    name: "app build failures have a dedicated error type",
    run() {
      const cause = new Error("builder exited with code 1");
      const error = new AppBuildError(cause);
      assert.equal(error.name, "AppBuildError");
      assert.equal(error.cause, cause);
      assert.match(error.message, /Electron app build failed/);
    },
  },
];
