import { describe, expect, it } from "vitest";
import { validateBrowserProfile } from "./browser-profile";

describe("validateBrowserProfile", () => {
  it("normalizes locale and timezone values", () => {
    expect(
      validateBrowserProfile({
        locale: "en-us",
        timezoneId: "utc",
        userAgent: "  Playwright Test Agent  ",
        viewport: {
          width: 1440,
          height: 900,
        },
      }),
    ).toEqual({
      normalizedProfile: {
        locale: "en-US",
        timezoneId: "UTC",
        userAgent: "Playwright Test Agent",
        viewport: {
          width: 1440,
          height: 900,
        },
      },
      fieldErrors: {},
    });
  });

  it("reports field-level errors for invalid locale and timezone", () => {
    expect(
      validateBrowserProfile({
        locale: "bad locale",
        timezoneId: "Mars/Olympus",
      }),
    ).toEqual({
      normalizedProfile: undefined,
      fieldErrors: {
        locale: "Locale must be a valid BCP 47 language tag.",
        timezoneId: "Timezone must be a supported IANA time zone.",
      },
    });
  });
});
