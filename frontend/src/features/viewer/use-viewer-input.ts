import {
  useCallback,
  useRef,
  type CompositionEventHandler,
  type FormEventHandler,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type RefObject,
  type WheelEventHandler,
} from "react";
import type { ClientInputMessage } from "@browser-viewer/shared";
import {
  extractKeyboardModifiers,
  mapClientPointToCanvas,
} from "../../lib/coordinate";

interface UseViewerInputParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  inputBridgeRef: RefObject<HTMLTextAreaElement | null>;
  sendInput: (input: ClientInputMessage) => void;
}

interface UseViewerInputResult {
  onMouseDown: MouseEventHandler<HTMLCanvasElement>;
  onMouseMove: MouseEventHandler<HTMLCanvasElement>;
  onWheel: WheelEventHandler<HTMLCanvasElement>;
  onContextMenu: MouseEventHandler<HTMLCanvasElement>;
  onMouseLeave: MouseEventHandler<HTMLCanvasElement>;
  onBridgeKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onBridgeInput: FormEventHandler<HTMLTextAreaElement>;
  onBridgeCompositionStart: CompositionEventHandler<HTMLTextAreaElement>;
  onBridgeCompositionEnd: CompositionEventHandler<HTMLTextAreaElement>;
}

const FORWARDED_KEYS = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function shouldForwardAsKeyboardShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return true;
  }

  return FORWARDED_KEYS.has(event.key);
}

export function useViewerInput({
  canvasRef,
  inputBridgeRef,
  sendInput,
}: UseViewerInputParams): UseViewerInputResult {
  const lastMoveAtRef = useRef(0);
  const composingRef = useRef(false);

  const sendClipboardPaste = useCallback(
    (text: string): void => {
      if (!text) {
        return;
      }
      sendInput({ type: "clipboard", action: "paste", text });
    },
    [sendInput],
  );

  const sendKeyboardInput = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
      >,
    ): void => {
      sendInput({
        type: "keyboard",
        key: event.key,
        modifiers: extractKeyboardModifiers(event),
      });
    },
    [sendInput],
  );

  const isPasteShortcut = useCallback(
    (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean => {
      return (
        event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)
      );
    },
    [],
  );

  const mapPointerEvent = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return null;
      }
      return mapClientPointToCanvas(
        clientX,
        clientY,
        canvas.getBoundingClientRect(),
        canvas.width,
        canvas.height,
      );
    },
    [canvasRef],
  );

  const onMouseDown = useCallback<MouseEventHandler<HTMLCanvasElement>>(
    (event) => {
      event.preventDefault();
      if (inputBridgeRef.current) {
        inputBridgeRef.current.style.left = `${event.clientX}px`;
        inputBridgeRef.current.style.top = `${event.clientY}px`;
        inputBridgeRef.current.focus();
      }
      const point = mapPointerEvent(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      sendInput({
        type: "mouse",
        action: "click",
        x: point.x,
        y: point.y,
        button:
          event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
      });
    },
    [inputBridgeRef, mapPointerEvent, sendInput],
  );

  const onMouseMove = useCallback<MouseEventHandler<HTMLCanvasElement>>(
    (event) => {
      const now = Date.now();
      if (now - lastMoveAtRef.current < 16) {
        return;
      }
      lastMoveAtRef.current = now;

      const point = mapPointerEvent(event.clientX, event.clientY);
      if (!point) {
        return;
      }
      sendInput({
        type: "mouse",
        action: "move",
        x: point.x,
        y: point.y,
      });
    },
    [mapPointerEvent, sendInput],
  );

  const onWheel = useCallback<WheelEventHandler<HTMLCanvasElement>>(
    (event) => {
      event.preventDefault();
      const point = mapPointerEvent(event.clientX, event.clientY);
      sendInput({
        type: "scroll",
        x: point?.x,
        y: point?.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    [mapPointerEvent, sendInput],
  );

  const onContextMenu = useCallback<MouseEventHandler<HTMLCanvasElement>>(
    (event) => {
      event.preventDefault();
    },
    [],
  );

  const onMouseLeave = useCallback<MouseEventHandler<HTMLCanvasElement>>(() => {
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "default";
    }
  }, [canvasRef]);

  const onBridgeKeyDown = useCallback<
    KeyboardEventHandler<HTMLTextAreaElement>
  >(
    (event) => {
      if (event.nativeEvent.isComposing || composingRef.current) {
        return;
      }

      if (isPasteShortcut(event)) {
        event.preventDefault();
        if (!navigator.clipboard?.readText) {
          sendKeyboardInput(event);
          return;
        }
        void navigator.clipboard
          .readText()
          .then((text) => {
            sendClipboardPaste(text);
          })
          .catch(() => {
            sendKeyboardInput(event);
          });
        return;
      }

      if (shouldForwardAsKeyboardShortcut(event)) {
        event.preventDefault();
        sendKeyboardInput(event);
      }
    },
    [isPasteShortcut, sendClipboardPaste, sendKeyboardInput],
  );

  const onBridgeInput = useCallback<FormEventHandler<HTMLTextAreaElement>>(
    (event) => {
      if (composingRef.current) {
        return;
      }

      const text = event.currentTarget.value;
      if (!text) {
        return;
      }

      sendClipboardPaste(text);
      event.currentTarget.value = "";
    },
    [sendClipboardPaste],
  );

  const onBridgeCompositionStart = useCallback<
    CompositionEventHandler<HTMLTextAreaElement>
  >(() => {
    composingRef.current = true;
  }, []);

  const onBridgeCompositionEnd = useCallback<
    CompositionEventHandler<HTMLTextAreaElement>
  >(
    (event) => {
      composingRef.current = false;
      const text = event.currentTarget.value;
      if (!text) {
        return;
      }

      sendClipboardPaste(text);
      event.currentTarget.value = "";
    },
    [sendClipboardPaste],
  );

  return {
    onMouseDown,
    onMouseMove,
    onWheel,
    onContextMenu,
    onMouseLeave,
    onBridgeKeyDown,
    onBridgeInput,
    onBridgeCompositionStart,
    onBridgeCompositionEnd,
  };
}
