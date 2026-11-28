import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMemoizedFn } from "ahooks";
import { deviceStorage } from "../../../features/device-storage";

export const DEFAULT_RAIL_WIDTH_PX = 236;
export const MIN_RAIL_WIDTH_PX = 180;
export const MAX_RAIL_WIDTH_PX = 420;
const RAIL_KEYBOARD_RESIZE_STEP_PX = 16;

function railCollapsedStorageKey(scope: string): string {
  return `viewer.terminal.worktree-rail-collapsed.${scope}`;
}

function railWidthStorageKey(scope: string): string {
  return `viewer.terminal.worktree-rail-width.${scope}`;
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH_PX, Math.max(MIN_RAIL_WIDTH_PX, width));
}

function readRailWidth(scope: string): number {
  const storedWidth = Number.parseInt(
    deviceStorage.getItem(railWidthStorageKey(scope)) ?? "",
    10,
  );
  return Number.isFinite(storedWidth)
    ? clampRailWidth(storedWidth)
    : DEFAULT_RAIL_WIDTH_PX;
}

export function useWorktreeRailLayout(scope: string) {
  const [collapsed, setCollapsed] = useState(
    () => deviceStorage.getItem(railCollapsedStorageKey(scope)) === "true",
  );
  const [width, setWidth] = useState(() => readRailWidth(scope));
  const [resizing, setResizing] = useState(false);
  const resizeStateRef = useRef<{
    railLeft: number;
    width: number;
    scope: string;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  const handleResizePointerMove = useMemoizedFn((event: PointerEvent) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState) return;
    const nextWidth = clampRailWidth(
      Math.round(event.clientX - resizeState.railLeft),
    );
    resizeState.width = nextWidth;
    setWidth(nextWidth);
  });

  const stopResize = useMemoizedFn(() => {
    const resizeState = resizeStateRef.current;
    resizeStateRef.current = null;
    window.removeEventListener("pointermove", handleResizePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    setResizing(false);
    if (!resizeState) return;
    document.body.style.cursor = resizeState.previousCursor;
    document.body.style.userSelect = resizeState.previousUserSelect;
    deviceStorage.setItem(
      railWidthStorageKey(resizeState.scope),
      String(resizeState.width),
    );
  });

  const startResize = useMemoizedFn(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rail = event.currentTarget.closest("aside");
      if (!rail) return;
      resizeStateRef.current = {
        railLeft: rail.getBoundingClientRect().left,
        width,
        scope,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setResizing(true);
      window.addEventListener("pointermove", handleResizePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
  );

  const resizeWithKeyboard = useMemoizedFn(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const nextWidth =
        event.key === "Home"
          ? MIN_RAIL_WIDTH_PX
          : event.key === "End"
            ? MAX_RAIL_WIDTH_PX
            : event.key === "ArrowLeft"
              ? clampRailWidth(width - RAIL_KEYBOARD_RESIZE_STEP_PX)
              : event.key === "ArrowRight"
                ? clampRailWidth(width + RAIL_KEYBOARD_RESIZE_STEP_PX)
                : null;
      if (nextWidth === null) return;
      event.preventDefault();
      setWidth(nextWidth);
      deviceStorage.setItem(railWidthStorageKey(scope), String(nextWidth));
    },
  );

  useEffect(() => {
    stopResize();
    setCollapsed(
      deviceStorage.getItem(railCollapsedStorageKey(scope)) === "true",
    );
    setWidth(readRailWidth(scope));
  }, [scope, stopResize]);

  useEffect(() => stopResize, [stopResize]);

  const toggleCollapsed = useMemoizedFn(() => {
    setCollapsed((current) => {
      const next = !current;
      deviceStorage.setItem(railCollapsedStorageKey(scope), String(next));
      return next;
    });
  });

  return {
    collapsed,
    setCollapsed,
    width,
    resizing,
    startResize,
    resizeWithKeyboard,
    toggleCollapsed,
  };
}
