import { describe, expect, it } from "vitest";
import {
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
  isSupportedTerminalImagePreviewPath,
  extensionToLanguageHint,
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

  it("maps file extensions to Monaco language hints", () => {
    expect(extensionToLanguageHint("src/index.ts")).toBe("typescript");
    expect(extensionToLanguageHint("src/App.tsx")).toBe("typescriptreact");
    expect(extensionToLanguageHint("lib/utils.js")).toBe("javascript");
    expect(extensionToLanguageHint("README.md")).toBe("markdown");
    expect(extensionToLanguageHint("icon.svg")).toBe("svg");
    expect(extensionToLanguageHint("config.yaml")).toBe("yaml");
    expect(extensionToLanguageHint("main.py")).toBe("python");
    expect(extensionToLanguageHint("main.go")).toBe("go");
    expect(extensionToLanguageHint("style.css")).toBe("css");
    expect(extensionToLanguageHint("data.json")).toBe("json");
    expect(extensionToLanguageHint("page.html")).toBe("html");
    expect(extensionToLanguageHint("script.sh")).toBe("shell");
  });

  it("returns null for unknown extensions", () => {
    expect(extensionToLanguageHint("binary.dat")).toBeNull();
    expect(extensionToLanguageHint("noext")).toBeNull();
  });

  it("detects Dockerfile without extension", () => {
    expect(extensionToLanguageHint("Dockerfile")).toBe("dockerfile");
    expect(extensionToLanguageHint("deploy/Dockerfile")).toBe("dockerfile");
  });
});
