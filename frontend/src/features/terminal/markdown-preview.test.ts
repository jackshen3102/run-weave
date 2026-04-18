import { describe, expect, it } from "vitest";
import {
  resolveMarkdownPreviewAssetPath,
  resolveMarkdownPreviewHref,
} from "./markdown-preview";

describe("markdown preview links", () => {
  it("resolves project-relative markdown links from the current document", () => {
    expect(
      resolveMarkdownPreviewHref("docs/architecture/plan.md", "./next.md"),
    ).toEqual({ kind: "preview-file", path: "docs/architecture/next.md" });
    expect(
      resolveMarkdownPreviewHref("docs/architecture/plan.md", "../testing/layers.md"),
    ).toEqual({ kind: "preview-file", path: "docs/testing/layers.md" });
  });

  it("preserves hash targets for preview-file links", () => {
    expect(
      resolveMarkdownPreviewHref("docs/plan.md", "./next.md#section-one"),
    ).toEqual({
      kind: "preview-file",
      path: "docs/next.md",
      hash: "section-one",
    });
  });

  it("keeps same-document hash links inside the rendered markdown", () => {
    expect(resolveMarkdownPreviewHref("docs/plan.md", "#goals")).toEqual({
      kind: "same-document-hash",
      hash: "goals",
    });
  });

  it("rejects links that escape the project path", () => {
    expect(resolveMarkdownPreviewHref("docs/plan.md", "../../outside.md")).toEqual({
      kind: "outside-project",
    });
  });

  it("treats external links as browser links only for safe protocols", () => {
    expect(resolveMarkdownPreviewHref("docs/plan.md", "https://example.com")).toEqual({
      kind: "external",
      href: "https://example.com",
    });
    expect(resolveMarkdownPreviewHref("docs/plan.md", "javascript:alert(1)")).toEqual({
      kind: "blocked",
    });
  });

  it("resolves local markdown image sources relative to the current document", () => {
    expect(
      resolveMarkdownPreviewAssetPath(
        "docs/architecture/terminal-code-preview.md",
        "assets/terminal-code-preview-open-file.svg",
      ),
    ).toBe("docs/architecture/assets/terminal-code-preview-open-file.svg");
    expect(
      resolveMarkdownPreviewAssetPath("docs/plan.md", "https://example.com/a.png"),
    ).toBeNull();
    expect(resolveMarkdownPreviewAssetPath("docs/plan.md", "../../secret.png")).toBeNull();
  });
});
