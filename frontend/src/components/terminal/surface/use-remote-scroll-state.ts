import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalScrollState } from "@runweave/shared/terminal/websocket";
import type { TerminalScrollController } from "../input/use-terminal-scroll-controller";

export function useRemoteTerminalScrollState(scroll: TerminalScrollController, reset: () => void,
  refresh: () => void, status: string, panelId: string | null) {
  const feedbackRef = useRef<((state: TerminalScrollState) => void) | null>(null);
  const { clearRemoteState, applyRemoteState } = scroll;
  useEffect(() => { reset(); clearRemoteState(); if (status === "connected") refresh(); }, [status, panelId, reset, clearRemoteState, refresh]);
  return { feedbackRef, refresh,
    receive: useMemoizedFn((state: TerminalScrollState) => { feedbackRef.current?.(state); applyRemoteState(state); }),
  };
}

export function useVisibleTerminalOutput(visibleRef: RefObject<boolean>, visible: boolean, replay: () => void, cancelScroll: () => void) {
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (visible) replay(); else cancelScroll();
  }, [visibleRef, visible, replay, cancelScroll]);
}
