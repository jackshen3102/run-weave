import { describe, expect, it } from "vitest";
import { parseBrowserProfileInput, parseSessionHeaders } from "./utils";

describe("home utils", () => {
  it("parses browser profile inputs into a launch profile payload", () => {
    expect(
      parseBrowserProfileInput({
        localeInput: " en-us ",
        timezoneIdInput: " utc ",
        userAgentInput: " Playwright Stable Test Agent ",
        viewportWidthInput: "1440",
        viewportHeightInput: "900",
      }),
    ).toEqual({
      locale: "en-US",
      timezoneId: "UTC",
      userAgent: "Playwright Stable Test Agent",
      viewport: {
        width: 1440,
        height: 900,
      },
    });
  });

  it("returns undefined when browser profile inputs are empty", () => {
    expect(
      parseBrowserProfileInput({
        localeInput: " ",
        timezoneIdInput: "",
        userAgentInput: " ",
        viewportWidthInput: "",
        viewportHeightInput: "",
      }),
    ).toBeUndefined();
  });

  it("rejects incomplete viewport input", () => {
    expect(() =>
      parseBrowserProfileInput({
        localeInput: "",
        timezoneIdInput: "",
        userAgentInput: "",
        viewportWidthInput: "1440",
        viewportHeightInput: "",
      }),
    ).toThrow("Viewport width and height must be provided together.");
  });

  it("rejects invalid locale and timezone values before submit", () => {
    expect(() =>
      parseBrowserProfileInput({
        localeInput: "bad locale",
        timezoneIdInput: "Mars/Olympus",
        userAgentInput: "",
        viewportWidthInput: "",
        viewportHeightInput: "",
      }),
    ).toThrow("Locale must be a valid BCP 47 language tag.");

    expect(() =>
      parseBrowserProfileInput({
        localeInput: "",
        timezoneIdInput: "Mars/Olympus",
        userAgentInput: "",
        viewportWidthInput: "",
        viewportHeightInput: "",
      }),
    ).toThrow("Timezone must be a supported IANA time zone.");
  });

  it("keeps request header parsing intact", () => {
    expect(parseSessionHeaders('{"x-session-id":"demo"}')).toEqual({
      "x-session-id": "demo",
    });
  });
});
