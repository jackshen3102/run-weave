import type { TerminalRendererExtensionContext } from "@runweave/terminal-renderer";
import { buildTmuxScrollInput } from "@runweave/common/terminal";

const APP_TERMINAL_TOUCH_SCROLL_MULTIPLIER = 3;
const APP_TERMINAL_EDGE_SWIPE_ZONE = 24;

export interface TerminalTouchBehaviorOptions {
  // Latest runtime kind; tmux-backed sessions can be scrolled while a
  // full-screen TUI owns the alternate screen by forwarding mouse sequences.
  getRuntimeKind?: () => "tmux" | "pty" | null;
  // Sends raw input to the terminal session (same channel as keystrokes).
  sendInput?: (data: string) => void;
  onTmuxScrollbackDistanceChange?: (deltaRows: number) => void;
  allowMouseDragScroll?: boolean;
}

export function installTerminalTouchBehavior(
  { terminal, container }: TerminalRendererExtensionContext,
  options: TerminalTouchBehaviorOptions = {},
): { dispose(): void } {
  const {
    allowMouseDragScroll,
    getRuntimeKind,
    onTmuxScrollbackDistanceChange,
    sendInput,
  } = options;
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

  const isScrollablePointer = (event: PointerEvent) =>
    event.pointerType === "touch" ||
    (allowMouseDragScroll === true && event.pointerType === "mouse");

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
    accumulatedDelta -= lines * lineHeight;

    const buffer = terminal.buffer?.active;
    const isAlternateScreen = buffer?.type === "alternate";

    // On the alternate screen (full-screen TUI like codex/vim) xterm has no
    // scrollback, so scrollLines does nothing. Match the Web behavior: forward
    // SGR mouse-wheel sequences so tmux (mouse on) scrolls the TUI itself.
    if (isAlternateScreen && getRuntimeKind?.() === "tmux" && sendInput) {
      // lines>0 = dragging down = reveal older content = wheel up. buildTmuxScrollInput
      // treats deltaY<0 as wheel up, so negate to map the sign correctly. It emits
      // one wheel notch per call, so repeat it to match the gesture magnitude.
      const notch = buildTmuxScrollInput(-Math.sign(lines), terminal.cols, terminal.rows);
      if (notch) {
        sendInput(notch.repeat(Math.abs(lines)));
        onTmuxScrollbackDistanceChange?.(lines);
      }
      return;
    }

    terminal.scrollLines(-lines);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!isScrollablePointer(event)) {
      suppressPointerFocus(event);
      return;
    }

    edgeSwipeActive =
      event.pointerType === "touch" &&
      event.clientX <= APP_TERMINAL_EDGE_SWIPE_ZONE;
    if (edgeSwipeActive) {
      activePointerId = null;
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }

    if (event.pointerType !== "touch") {
      event.preventDefault();
    }
    event.stopPropagation();
    activePointerId = event.pointerId;
    lastTouchY = event.clientY;
    accumulatedDelta = 0;
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events used in browser automation may not have an
      // active pointer capture target.
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (
      !isScrollablePointer(event) ||
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
      try {
        container.releasePointerCapture?.(event.pointerId);
      } catch {
        // See the setPointerCapture guard above.
      }
    }
    resetScrollGesture();
  };

  const handleWheel = (event: WheelEvent) => {
    const buffer = terminal.buffer?.active;
    if (buffer?.type !== "alternate" || getRuntimeKind?.() !== "tmux") {
      return;
    }

    const lineHeight = resolveLineHeight();
    if (lineHeight <= 0 || event.deltaY === 0) {
      return;
    }

    onTmuxScrollbackDistanceChange?.(-event.deltaY / lineHeight);
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
  container.addEventListener("wheel", handleWheel, { capture: true });
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
      container.removeEventListener("wheel", handleWheel, { capture: true });
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
