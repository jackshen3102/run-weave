import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";

// Matches the `pl-2 pt-1.5` padding on the xterm mount div in
// terminal-surface-layout.tsx. Handle positions are relative to that content
// box, so we compensate for the padding offset here.
const TERMINAL_CONTENT_PADDING_LEFT_PX = 8;
const TERMINAL_CONTENT_PADDING_TOP_PX = 6;

interface TerminalCellSize {
  width: number;
  height: number;
}

// xterm exposes the rendered cell size only through its proposed internal API.
// `allowProposedApi` is already enabled where the terminal is created.
interface XtermRenderInternals {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width?: number; height?: number } } };
    };
  };
}

function getTerminalCellSize(terminal: Terminal | null): TerminalCellSize | null {
  const cell = (terminal as XtermRenderInternals | null)?._core?._renderService
    ?.dimensions?.css?.cell;
  if (!cell || !cell.width || !cell.height) {
    return null;
  }
  return { width: cell.width, height: cell.height };
}

type ResizeAxis = "vertical" | "horizontal";

interface PaneResizeHandle {
  key: string;
  axis: ResizeAxis;
  panelId: string;
  // Position of the divider centre within the content box, before drag offset.
  offsetPx: number;
  // Extent of the handle along the perpendicular axis (start + length in px).
  crossStartPx: number;
  crossLengthPx: number;
}

/**
 * Build the drag handles for a tmux main-vertical layout:
 *
 * - one vertical handle on the full-height left "main" pane's right border,
 *   dragged to rebalance the main terminal against the worker column;
 * - one horizontal handle on the bottom border of each worker pane that is not
 *   flush with the window bottom, dragged to rebalance the stacked workers.
 *
 * Returns an empty list for any layout without geometry so nothing renders.
 */
function buildResizeHandles(
  workspace: TerminalPanelWorkspace | null,
  cellSize: TerminalCellSize | null,
): PaneResizeHandle[] {
  if (
    !workspace ||
    !cellSize ||
    !Array.isArray(workspace.panels) ||
    workspace.panels.length < 2
  ) {
    return [];
  }
  const handles: PaneResizeHandle[] = [];
  for (const panel of workspace.panels) {
    const geometry = panel.geometry;
    if (!geometry) {
      continue;
    }
    const isMainVerticalPane =
      geometry.paneLeft === 0 &&
      geometry.paneTop === 0 &&
      geometry.paneHeight === geometry.windowHeight &&
      geometry.paneWidth < geometry.windowWidth;
    if (isMainVerticalPane) {
      handles.push({
        key: `${panel.panelId}:vertical`,
        axis: "vertical",
        panelId: panel.panelId,
        offsetPx:
          TERMINAL_CONTENT_PADDING_LEFT_PX +
          geometry.paneWidth * cellSize.width +
          cellSize.width / 2,
        crossStartPx: TERMINAL_CONTENT_PADDING_TOP_PX,
        crossLengthPx: geometry.paneHeight * cellSize.height,
      });
    }
    const hasPaneBelow = geometry.paneTop + geometry.paneHeight < geometry.windowHeight;
    if (hasPaneBelow) {
      handles.push({
        key: `${panel.panelId}:horizontal`,
        axis: "horizontal",
        panelId: panel.panelId,
        offsetPx:
          TERMINAL_CONTENT_PADDING_TOP_PX +
          (geometry.paneTop + geometry.paneHeight) * cellSize.height +
          cellSize.height / 2,
        crossStartPx:
          TERMINAL_CONTENT_PADDING_LEFT_PX + geometry.paneLeft * cellSize.width,
        crossLengthPx: geometry.paneWidth * cellSize.width,
      });
    }
  }
  return handles;
}

interface TerminalPaneResizeOverlayProps {
  workspace: TerminalPanelWorkspace | null;
  terminalRef: RefObject<Terminal | null>;
  onResize: (
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
}

export function TerminalPaneResizeOverlay({
  workspace,
  terminalRef,
  onResize,
}: TerminalPaneResizeOverlayProps) {
  const [dragOffsetPx, setDragOffsetPx] = useState<number | null>(null);
  const dragStateRef = useRef<{
    panelId: string;
    axis: ResizeAxis;
    startClientPos: number;
    cellSpan: number;
  } | null>(null);

  const cellSize = getTerminalCellSize(terminalRef.current);
  const handles = buildResizeHandles(workspace, cellSize);

  const handlePointerMove = useMemoizedFn((event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState) {
      return;
    }
    const clientPos =
      dragState.axis === "vertical" ? event.clientX : event.clientY;
    setDragOffsetPx(clientPos - dragState.startClientPos);
  });

  const handlePointerUp = useMemoizedFn((event: PointerEvent) => {
    const dragState = dragStateRef.current;
    dragStateRef.current = null;
    setDragOffsetPx(null);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    if (!dragState) {
      return;
    }
    const clientPos =
      dragState.axis === "vertical" ? event.clientX : event.clientY;
    const deltaPx = clientPos - dragState.startClientPos;
    const cells = Math.round(deltaPx / dragState.cellSpan);
    if (cells === 0) {
      return;
    }
    const direction =
      dragState.axis === "vertical"
        ? cells > 0
          ? "right"
          : "left"
        : cells > 0
          ? "down"
          : "up";
    onResize(dragState.panelId, direction, Math.abs(cells));
  });

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  if (handles.length === 0 || !cellSize) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {handles.map((handle) => {
        const isVertical = handle.axis === "vertical";
        const isDragging =
          dragOffsetPx !== null &&
          dragStateRef.current?.panelId === handle.panelId &&
          dragStateRef.current?.axis === handle.axis;
        const renderedOffsetPx = handle.offsetPx + (isDragging ? dragOffsetPx : 0);
        const cellSpan = isVertical ? cellSize.width : cellSize.height;
        return (
          <button
            key={handle.key}
            type="button"
            aria-label={
              isVertical
                ? "Drag to resize main terminal width"
                : "Drag to resize terminal pane height"
            }
            className={[
              "pointer-events-auto absolute",
              isVertical
                ? "top-0 h-full w-2 -translate-x-1/2 cursor-col-resize before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2"
                : "left-0 w-full h-2 -translate-y-1/2 cursor-row-resize before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2",
              "before:absolute before:transition-colors",
              isDragging
                ? isVertical
                  ? "before:w-0.5 before:bg-sky-400"
                  : "before:h-0.5 before:bg-sky-400"
                : "before:bg-transparent hover:before:bg-sky-400/60",
            ].join(" ")}
            style={
              isVertical
                ? {
                    left: `${renderedOffsetPx}px`,
                    top: `${handle.crossStartPx}px`,
                    height: `${handle.crossLengthPx}px`,
                  }
                : {
                    top: `${renderedOffsetPx}px`,
                    left: `${handle.crossStartPx}px`,
                    width: `${handle.crossLengthPx}px`,
                  }
            }
            onPointerDown={(event) => {
              event.preventDefault();
              dragStateRef.current = {
                panelId: handle.panelId,
                axis: handle.axis,
                startClientPos: isVertical ? event.clientX : event.clientY,
                cellSpan,
              };
              setDragOffsetPx(0);
              window.addEventListener("pointermove", handlePointerMove);
              window.addEventListener("pointerup", handlePointerUp);
            }}
          />
        );
      })}
    </div>
  );
}
