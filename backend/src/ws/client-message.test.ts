import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./client-message";

describe("parseClientMessage", () => {
  it("parses devtools open message", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "devtools",
        action: "open",
        tabId: "tab-1",
      }),
    );

    expect(parsed).toEqual({
      type: "devtools",
      action: "open",
      tabId: "tab-1",
    });
  });

  it("parses devtools close message", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "devtools",
        action: "close",
        tabId: "tab-1",
      }),
    );

    expect(parsed).toEqual({
      type: "devtools",
      action: "close",
      tabId: "tab-1",
    });
  });

  it("rejects devtools message without tabId", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "devtools",
        action: "open",
      }),
    );

    expect(parsed).toBeNull();
  });

  it("rejects malformed json", () => {
    const parsed = parseClientMessage("{ invalid");

    expect(parsed).toBeNull();
  });

  it("rejects navigation goto without url", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "navigation",
        action: "goto",
        tabId: "tab-1",
      }),
    );

    expect(parsed).toBeNull();
  });
});
