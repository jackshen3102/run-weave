import { describe, expect, it } from "vitest";
import { getViewerSecurityState } from "./viewer-security";

describe("getViewerSecurityState", () => {
  it("marks https pages as secure", () => {
    expect(getViewerSecurityState("https://example.com/docs")).toEqual({
      label: "Secure",
      hostname: "example.com",
      tone: "secure",
    });
  });

  it("marks http pages as not secure", () => {
    expect(getViewerSecurityState("http://example.com/docs")).toEqual({
      label: "Not secure",
      hostname: "example.com",
      tone: "insecure",
    });
  });

  it("treats internal pages as browser pages", () => {
    expect(getViewerSecurityState("about:blank")).toEqual({
      label: "Browser page",
      hostname: "about:blank",
      tone: "neutral",
    });
  });

  it("returns an empty state when there is no current url", () => {
    expect(getViewerSecurityState("")).toEqual({
      label: "No page",
      hostname: "",
      tone: "neutral",
    });
  });
});
