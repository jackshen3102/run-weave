import { describe, expect, it } from "vitest";
import {
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
  isSupportedTerminalImagePreviewPath,
} from "./preview-file-types";

describe("terminal preview file types", () => {
  it("detects markdown, svg, image, and text preview kinds", () => {
    expect(getTerminalPreviewFileKind("docs/Plan.MDX", "plaintext")).toBe(
      "markdown",
    );
    expect(getTerminalPreviewFileKind("assets/icon.svg", "plaintext")).toBe(
      "svg",
    );
    expect(getTerminalPreviewFileKind("screenshots/result.webp", "plaintext")).toBe(
      "image",
    );
    expect(getTerminalPreviewFileKind("src/main.ts", "typescript")).toBe("text");
  });

  it("keeps svg out of the raster image asset path", () => {
    expect(isSupportedTerminalImagePreviewPath("assets/result.png")).toBe(true);
    expect(isSupportedTerminalImagePreviewPath("assets/result.avif")).toBe(true);
    expect(isSupportedTerminalImagePreviewPath("assets/vector.svg")).toBe(false);
  });

  it("maps svg preview language to xml for Monaco source view", () => {
    expect(getTerminalPreviewMonacoLanguage("svg")).toBe("xml");
    expect(getTerminalPreviewMonacoLanguage("typescript")).toBe("typescript");
    expect(getTerminalPreviewMonacoLanguage("")).toBe("plaintext");
  });
});
