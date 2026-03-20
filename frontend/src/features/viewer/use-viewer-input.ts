import {
  useCallback,
  useRef,
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
  sendInput: (input: ClientInputMessage) => void;
}

interface UseViewerInputResult {
  onMouseDown: MouseEventHandler<HTMLCanvasElement>;
  onMouseMove: MouseEventHandler<HTMLCanvasElement>;
  onWheel: WheelEventHandler<HTMLCanvasElement>;
  onContextMenu: MouseEventHandler<HTMLCanvasElement>;
  onMouseLeave: MouseEventHandler<HTMLCanvasElement>;
  onKeyDown: KeyboardEventHandler<HTMLCanvasElement>;
}

export function useViewerInput({
  canvasRef,
  sendInput,
}: UseViewerInputParams): UseViewerInputResult {
  const lastMoveAtRef = useRef(0);

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
      event.currentTarget.focus();
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
    [mapPointerEvent, sendInput],
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

  const onKeyDown = useCallback<KeyboardEventHandler<HTMLCanvasElement>>(
    (event) => {
      event.preventDefault();
      sendInput({
        type: "keyboard",
        key: event.key,
        modifiers: extractKeyboardModifiers(event),
      });
    },
    [sendInput],
  );

  return {
    onMouseDown,
    onMouseMove,
    onWheel,
    onContextMenu,
    onMouseLeave,
    onKeyDown,
  };
}
