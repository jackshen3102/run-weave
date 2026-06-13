import type { TerminalRendererExtensionContext } from "@browser-viewer/terminal-renderer";

const APP_TERMINAL_TOUCH_SCROLL_MULTIPLIER = 3;
const APP_TERMINAL_EDGE_SWIPE_ZONE = 24;

export function installTerminalTouchBehavior({
  terminal,
  container,
}: TerminalRendererExtensionContext): { dispose(): void } {
  let lastTouchY: number | null = null;
  let accumulatedDelta = 0;
  let edgeSwipeActive = false;
  let activePointerId: number | null = null;

  const resolveLineHeight = () => {
    const firstRow = container.querySelector<HTMLElement>(".xterm-rows > div");
    const measuredLineHeight = firstRow?.getBoundingClientRect().height ?? 0;
    if (measuredLineHeight > 0) {
      return measuredLineHeight;
    }
    return container.clientHeight / Math.max(terminal.rows, 1);
  };

  const suppressTerminalFocus = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    terminal.blur();
  };

  const suppressPointerFocus = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    suppressTerminalFocus(event);
  };

  const resetScrollGesture = () => {
    lastTouchY = null;
    accumulatedDelta = 0;
    edgeSwipeActive = false;
    activePointerId = null;
  };

  const applyScrollDelta = (currentY: number, event: Event) => {
    if (lastTouchY === null) {
      lastTouchY = currentY;
      return;
    }

    accumulatedDelta +=
      (currentY - lastTouchY) * APP_TERMINAL_TOUCH_SCROLL_MULTIPLIER;
    lastTouchY = currentY;

    const lineHeight = resolveLineHeight();
    if (lineHeight <= 0) {
      return;
    }

    const lines = Math.trunc(accumulatedDelta / lineHeight);
    if (lines === 0) {
      return;
    }

    event.preventDefault();
    terminal.scrollLines(-lines);
    accumulatedDelta -= lines * lineHeight;
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      suppressPointerFocus(event);
      return;
    }

    edgeSwipeActive = event.clientX <= APP_TERMINAL_EDGE_SWIPE_ZONE;
    if (edgeSwipeActive) {
      activePointerId = null;
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }

    event.stopPropagation();
    activePointerId = event.pointerId;
    lastTouchY = event.clientY;
    accumulatedDelta = 0;
    container.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (
      event.pointerType !== "touch" ||
      edgeSwipeActive ||
      activePointerId !== event.pointerId
    ) {
      return;
    }

    event.stopPropagation();
    applyScrollDelta(event.clientY, event);
  };

  const handlePointerEnd = (event: PointerEvent) => {
    if (activePointerId === event.pointerId) {
      container.releasePointerCapture?.(event.pointerId);
    }
    resetScrollGesture();
  };

  const handleTouchStart = (event: TouchEvent) => {
    const startX = event.touches[0]?.clientX ?? null;
    edgeSwipeActive =
      event.touches.length === 1 &&
      startX !== null &&
      startX <= APP_TERMINAL_EDGE_SWIPE_ZONE;
    if (edgeSwipeActive) {
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }
    event.stopPropagation();
    if (event.touches.length !== 1) {
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }
    lastTouchY = event.touches[0]?.clientY ?? null;
    accumulatedDelta = 0;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (edgeSwipeActive) {
      return;
    }
    event.stopPropagation();
    const currentY = event.touches[0]?.clientY;
    if (lastTouchY === null || currentY === undefined) {
      return;
    }

    applyScrollDelta(currentY, event);
  };

  const handleTouchEnd = () => {
    resetScrollGesture();
  };

  const usePointerTouch = typeof window.PointerEvent !== "undefined";
  container.addEventListener("pointerdown", handlePointerDown, {
    capture: true,
  });
  if (usePointerTouch) {
    container.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    container.addEventListener("pointerup", handlePointerEnd, {
      capture: true,
    });
    container.addEventListener("pointercancel", handlePointerEnd, {
      capture: true,
    });
  }
  container.addEventListener("mousedown", suppressTerminalFocus, {
    capture: true,
  });
  container.addEventListener("click", suppressTerminalFocus, {
    capture: true,
  });
  if (!usePointerTouch) {
    container.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd, { capture: true });
    container.addEventListener("touchcancel", handleTouchEnd, {
      capture: true,
    });
  }

  return {
    dispose() {
      container.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      if (usePointerTouch) {
        container.removeEventListener("pointermove", handlePointerMove, {
          capture: true,
        });
        container.removeEventListener("pointerup", handlePointerEnd, {
          capture: true,
        });
        container.removeEventListener("pointercancel", handlePointerEnd, {
          capture: true,
        });
      }
      container.removeEventListener("mousedown", suppressTerminalFocus, {
        capture: true,
      });
      container.removeEventListener("click", suppressTerminalFocus, {
        capture: true,
      });
      if (!usePointerTouch) {
        container.removeEventListener("touchstart", handleTouchStart, {
          capture: true,
        });
        container.removeEventListener("touchmove", handleTouchMove, {
          capture: true,
        });
        container.removeEventListener("touchend", handleTouchEnd, {
          capture: true,
        });
        container.removeEventListener("touchcancel", handleTouchEnd, {
          capture: true,
        });
      }
    },
  };
}
