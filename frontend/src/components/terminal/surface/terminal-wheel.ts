import type { Terminal } from "@xterm/xterm";
import type { TerminalScrollInput, TerminalScrollStop, TerminalScrollState } from "@runweave/shared/terminal/websocket";
import { createNormalizedScrollInput, createTmuxScrollInput, createTmuxScrollBatcher } from "@runweave/common/terminal";
import { shouldSuppressWheelInput } from "../../../features/terminal/viewport/wheel-input";
import type { createTerminalViewportState } from "../emulator/viewport-state";

type Ref<T> = { current: T };
export function createTerminalWheelHandler(terminal: Terminal, options: {
  activeRef: Ref<boolean>; runtimeKindRef: Ref<"tmux" | "pty" | null>;
  normalizedScrollRef: Ref<boolean>; singleRowScrollRef: Ref<boolean>;
  sendScroll: (input: TerminalScrollInput | TerminalScrollStop) => void;
  scrollFeedbackRef: Ref<((state: TerminalScrollState) => void) | null>;
  resetScrollInputRef: Ref<(() => void) | null>;
  sendTerminalInput: (data: string) => void;
  onTmuxExitCopyModeRequest: () => void; onTmuxScrollbackActiveChange: (active: boolean) => void;
  viewportState: ReturnType<typeof createTerminalViewportState>;
}) {
  const { activeRef, runtimeKindRef, normalizedScrollRef, singleRowScrollRef, sendScroll,
    scrollFeedbackRef, resetScrollInputRef, sendTerminalInput, onTmuxExitCopyModeRequest,
    onTmuxScrollbackActiveChange, viewportState } = options;
  const normalizedScroll = createNormalizedScrollInput((input) => {
    if (input.type === "scroll-stop" || activeRef.current) sendScroll(input);
  });
  const stopOnTouch = () => normalizedScroll.reset();
  terminal.element?.addEventListener("pointerdown", stopOnTouch, true);
  scrollFeedbackRef.current = normalizedScroll.feedback;
  const tmuxScroll = createTmuxScrollInput();
  const singleRowScroll = createTmuxScrollInput(true);
  const scrollBatcher = createTmuxScrollBatcher((input) => {
    if (activeRef.current) sendTerminalInput(input);
  });
  const resetScrollInput = () => {
    normalizedScroll.reset();
    scrollBatcher.reset();
    tmuxScroll.reset();
    singleRowScroll.reset();
    viewportState.emitBottomState();
  };
  resetScrollInputRef.current = resetScrollInput;
  const resetWhenHidden = () => { if (document.hidden) resetScrollInput(); };
  document.addEventListener("visibilitychange", resetWhenHidden);
  window.addEventListener("blur", resetScrollInput);
  const screen = terminal.element?.querySelector(".xterm-screen");
  terminal.attachCustomWheelEventHandler((event) => {
    if (runtimeKindRef.current === "tmux" && normalizedScrollRef.current && event.deltaY !== 0 && !event.shiftKey) {
      normalizedScroll.consume(event, (screen?.getBoundingClientRect().height ?? 0) / terminal.rows, terminal.rows);
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    const { baseY, viewportY } = terminal.buffer.active;
    const canScroll =
      event.deltaY < 0
        ? viewportY > 0
        : event.deltaY > 0 && viewportY < baseY;
    if (!shouldSuppressWheelInput(event, canScroll)) {
      scrollBatcher.flush();
      tmuxScroll.reset();
      singleRowScroll.reset();
      return true;
    }

    if (
      runtimeKindRef.current === "tmux" &&
      terminal.buffer.active.type === "alternate" &&
      event.deltaY !== 0 &&
      !event.shiftKey
    ) {
      if (event.deltaY > 0 && viewportState.isAtBottom()) {
        scrollBatcher.reset();
        tmuxScroll.reset();
        singleRowScroll.reset();
        onTmuxExitCopyModeRequest();
        onTmuxScrollbackActiveChange(false);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      const fine = singleRowScrollRef.current && terminal.modes.mouseTrackingMode === "none";
      const input = fine ? singleRowScroll : tmuxScroll;
      (fine ? tmuxScroll : singleRowScroll).reset();
      const scroll = input.consume(
        event,
        terminal.cols,
        terminal.rows,
        (screen?.getBoundingClientRect().height ?? 0) / terminal.rows,
        terminal.options.scrollSensitivity ?? 1,
      );
      if (scroll) {
        scrollBatcher.enqueue(scroll.input);
        if (scroll.rows < 0) {
          viewportState.markAwayFromBottom(-scroll.rows, fine ? 1 : 8);
          onTmuxScrollbackActiveChange(true);
        } else {
          const nextBottomState = viewportState.markTowardBottom(scroll.rows, fine ? 0 : 2);
          if (nextBottomState.isAtBottom) {
            onTmuxScrollbackActiveChange(false);
          }
        }
      }
    } else {
      scrollBatcher.flush();
      tmuxScroll.reset();
      singleRowScroll.reset();
    }

    event.preventDefault();
    event.stopPropagation();
    return false;
  });

  return { flush() { normalizedScroll.reset(); scrollBatcher.flush(); }, dispose() {
    document.removeEventListener("visibilitychange", resetWhenHidden);
    window.removeEventListener("blur", resetScrollInput);
    terminal.element?.removeEventListener("pointerdown", stopOnTouch, true);
    normalizedScroll.reset(); scrollBatcher.reset(); scrollFeedbackRef.current = null;
    resetScrollInputRef.current = null;
  } };
}
