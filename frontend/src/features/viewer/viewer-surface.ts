import type { ViewerConnectionStatus } from "./viewer-state";

export interface ViewerSurfaceState {
  visible: boolean;
  presentation: "hidden" | "overlay" | "badge";
  blocksInput: boolean;
  title: string;
  detail: string | null;
  tone: "neutral" | "warning";
  action: "reconnect" | null;
}

interface ViewerSurfaceParams {
  activeTabId: string | null;
  status: ViewerConnectionStatus;
  isLoading: boolean;
  error: string | null;
}

const HIDDEN_SURFACE_STATE: ViewerSurfaceState = {
  visible: false,
  presentation: "hidden",
  blocksInput: false,
  title: "",
  detail: null,
  tone: "neutral",
  action: null,
};

export function getViewerSurfaceState(
  params: ViewerSurfaceParams,
): ViewerSurfaceState {
  const { activeTabId, status, isLoading, error } = params;
  if (!activeTabId) {
    return HIDDEN_SURFACE_STATE;
  }

  if (status === "connecting") {
    return {
      visible: true,
      presentation: "overlay",
      blocksInput: true,
      title: "Connecting to browser",
      detail: "Waiting for the live page stream to start.",
      tone: "neutral",
      action: null,
    };
  }

  if (status === "reconnecting") {
    return {
      visible: true,
      presentation: "overlay",
      blocksInput: true,
      title: "Reconnecting to browser",
      detail: "Trying to restore the live page stream.",
      tone: "warning",
      action: null,
    };
  }

  if (status === "closed") {
    return {
      visible: true,
      presentation: "overlay",
      blocksInput: true,
      title: "Viewer disconnected",
      detail: error ?? "Open the menu to reconnect the current session.",
      tone: "warning",
      action: "reconnect",
    };
  }

  if (isLoading) {
    return {
      visible: true,
      presentation: "badge",
      blocksInput: false,
      title: "Loading page",
      detail: "Waiting for the next browser frame.",
      tone: "neutral",
      action: null,
    };
  }

  return HIDDEN_SURFACE_STATE;
}
