import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalPreviewStore, DEFAULT_MARKDOWN_VIEW_MODE } from "./preview-store";

describe("terminal preview store", () => {
  beforeEach(() => {
    useTerminalPreviewStore.setState({
      ui: { open: false, expanded: false },
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

  it("exports DEFAULT_MARKDOWN_VIEW_MODE as 'preview'", () => {
    expect(DEFAULT_MARKDOWN_VIEW_MODE).toBe("preview");
  });

  it("setExpanded toggles ui.expanded", () => {
    useTerminalPreviewStore.getState().setExpanded(true);
    expect(useTerminalPreviewStore.getState().ui.expanded).toBe(true);

    useTerminalPreviewStore.getState().setExpanded(false);
    expect(useTerminalPreviewStore.getState().ui.expanded).toBe(false);
  });

  it("closePreview resets expanded to false", () => {
    useTerminalPreviewStore.getState().openPreview("project-1", "file");
    useTerminalPreviewStore.getState().setExpanded(true);
    expect(useTerminalPreviewStore.getState().ui.expanded).toBe(true);

    useTerminalPreviewStore.getState().closePreview();
    expect(useTerminalPreviewStore.getState().ui.open).toBe(false);
    expect(useTerminalPreviewStore.getState().ui.expanded).toBe(false);
  });

  it("openPreview does not reset expanded state", () => {
    useTerminalPreviewStore.getState().setExpanded(true);
    useTerminalPreviewStore.getState().openPreview("project-1", "file");
    expect(useTerminalPreviewStore.getState().ui.expanded).toBe(true);
  });

  it("stores changesViewMode per project", () => {
    useTerminalPreviewStore.getState().updateProjectPreview("project-1", {
      mode: "changes",
      changesViewMode: "preview",
    });
    useTerminalPreviewStore.getState().updateProjectPreview("project-2", {
      mode: "changes",
      changesViewMode: "diff",
    });

    expect(
      useTerminalPreviewStore.getState().projects["project-1"]?.changesViewMode,
    ).toBe("preview");
    expect(
      useTerminalPreviewStore.getState().projects["project-2"]?.changesViewMode,
    ).toBe("diff");
  });
});
