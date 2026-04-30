import { describe, expect, it } from "vitest";
import {
  TERMINAL_BROWSER_HEADER_RULE_LIMIT,
  normalizeTerminalBrowserHeaderRules,
  validateTerminalBrowserHeaderRule,
} from "./terminal-browser-headers";

describe("terminal browser header rules", () => {
  it("normalizes valid SET rules", () => {
    expect(
      normalizeTerminalBrowserHeaderRules([
        {
          id: " rule-1 ",
          enabled: true,
          operation: "set",
          name: " X-Custom-Header ",
          value: "header-value",
          urlPattern: " *://example.com/* ",
        },
      ]),
    ).toEqual([
      {
        id: "rule-1",
        enabled: true,
        operation: "set",
        name: "X-Custom-Header",
        value: "header-value",
        urlPattern: "*://example.com/*",
      },
    ]);
  });

  it("rejects blocked or malformed headers", () => {
    expect(
      validateTerminalBrowserHeaderRule({
        id: "rule-1",
        enabled: true,
        operation: "set",
        name: "Cookie",
        value: "a=b",
        urlPattern: "*://*/*",
      }).fieldErrors.name,
    ).toBe("This header name is not supported.");

    expect(
      validateTerminalBrowserHeaderRule({
        id: "rule-2",
        enabled: true,
        operation: "set",
        name: "X-Bad:Header",
        value: "value",
        urlPattern: "*://*/*",
      }).fieldErrors.name,
    ).toBe("Header name cannot contain control characters or colon.");
  });

  it("requires a value and URL pattern", () => {
    const result = validateTerminalBrowserHeaderRule({
      id: "rule-1",
      enabled: true,
      operation: "set",
      name: "X-Custom-Header",
      value: " ",
      urlPattern: " ",
    });

    expect(result.fieldErrors).toMatchObject({
      value: "Header value is required.",
      urlPattern: "URL pattern is required.",
    });
  });

  it("limits the number of rules", () => {
    expect(() =>
      normalizeTerminalBrowserHeaderRules(
        Array.from(
          { length: TERMINAL_BROWSER_HEADER_RULE_LIMIT + 1 },
          (_, index) => ({
            id: `rule-${index}`,
            enabled: true,
            operation: "set",
            name: `X-Rule-${index}`,
            value: "value",
            urlPattern: "*://*/*",
          }),
        ),
      ),
    ).toThrow(
      `Header rules are limited to ${TERMINAL_BROWSER_HEADER_RULE_LIMIT}.`,
    );
  });
});
