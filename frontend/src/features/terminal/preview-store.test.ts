import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalPreviewStore } from "./preview-store";

describe("terminal preview store", () => {
  beforeEach(() => {
    useTerminalPreviewStore.setState({
      ui: { open: false },
      projects: {},
    });
  });

  it("opens preview for a project without overwriting existing project state", () => {
    useTerminalPreviewStore.getState().updateProjectPreview("project-1", {
      mode: "file",
      selectedFilePath: "README.md",
    });

    useTerminalPreviewStore.getState().openPreview("project-1", "changes");

    expect(useTerminalPreviewStore.getState().ui.open).toBe(true);
    expect(useTerminalPreviewStore.getState().projects["project-1"]).toEqual({
      mode: "changes",
      selectedFilePath: "README.md",
    });
  });

  it("keeps per-project preview state isolated", () => {
    useTerminalPreviewStore.getState().updateProjectPreview("project-1", {
      mode: "file",
      selectedFilePath: "README.md",
      markdownViewMode: "preview",
      markdownSplitSourceWidthPct: 64,
      svgViewMode: "source",
    });
    useTerminalPreviewStore.getState().updateProjectPreview("project-2", {
      mode: "changes",
      selectedChangePath: "docs/plan.md",
      selectedChangeKind: "working",
    });
    useTerminalPreviewStore.getState().removeProjectPreview("project-1");

    expect(useTerminalPreviewStore.getState().projects).toEqual({
      "project-2": {
        mode: "changes",
        selectedChangePath: "docs/plan.md",
        selectedChangeKind: "working",
      },
    });
  });

  it("stores markdown and svg file view preferences per project", () => {
    useTerminalPreviewStore.getState().updateProjectPreview("project-1", {
      mode: "file",
      markdownViewMode: "split",
      markdownSplitSourceWidthPct: 55,
      svgViewMode: "preview",
    });
    useTerminalPreviewStore.getState().updateProjectPreview("project-2", {
      mode: "file",
      markdownViewMode: "source",
      svgViewMode: "source",
    });

    expect(useTerminalPreviewStore.getState().projects["project-1"]).toEqual({
      mode: "file",
      markdownViewMode: "split",
      markdownSplitSourceWidthPct: 55,
      svgViewMode: "preview",
    });
    expect(useTerminalPreviewStore.getState().projects["project-2"]).toEqual({
      mode: "file",
      markdownViewMode: "source",
      svgViewMode: "source",
    });
  });
});
