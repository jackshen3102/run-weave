import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useViewerInput } from "./use-viewer-input";

describe("useViewerInput", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.assign(navigator, {
      clipboard: originalClipboard,
    });
  });

  it("maps pointer interactions into viewer input messages", () => {
    const sendInput = vi.fn();
    const focus = vi.fn();

    const { result } = renderHook(() => {
      const canvasRef = useRef<HTMLCanvasElement | null>(document.createElement("canvas"));
      const inputBridgeRef = useRef<HTMLTextAreaElement | null>(
        document.createElement("textarea"),
      );

      canvasRef.current!.width = 200;
      canvasRef.current!.height = 100;
      canvasRef.current!.style.cursor = "crosshair";
      canvasRef.current!.getBoundingClientRect = () =>
        ({
          left: 10,
          top: 20,
          width: 100,
          height: 50,
        }) as DOMRect;
      inputBridgeRef.current!.focus = focus;

      return useViewerInput({
        canvasRef,
        inputBridgeRef,
        sendInput,
      });
    });

    result.current.onMouseDown({
      preventDefault: vi.fn(),
      clientX: 60,
      clientY: 45,
      button: 2,
    } as never);

    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(120);

    result.current.onMouseMove({
      clientX: 35,
      clientY: 30,
    } as never);

    result.current.onWheel({
      preventDefault: vi.fn(),
      clientX: 70,
      clientY: 50,
      deltaX: 3,
      deltaY: 4,
    } as never);

    const preventContextMenu = vi.fn();
    result.current.onContextMenu({
      preventDefault: preventContextMenu,
    } as never);

    result.current.onMouseLeave({} as never);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenNthCalledWith(1, {
      type: "mouse",
      action: "click",
      x: 100,
      y: 50,
      button: "right",
    });
    expect(sendInput).toHaveBeenNthCalledWith(2, {
      type: "mouse",
      action: "move",
      x: 50,
      y: 20,
    });
    expect(sendInput).toHaveBeenNthCalledWith(3, {
      type: "scroll",
      x: 120,
      y: 60,
      deltaX: 3,
      deltaY: 4,
    });
    expect(preventContextMenu).toHaveBeenCalledTimes(1);
  });

  it("forwards keyboard shortcuts and clipboard paste", async () => {
    const sendInput = vi.fn();
    Object.assign(navigator, {
      clipboard: {
        readText: vi.fn(async () => "pasted text"),
      },
    });

    const { result } = renderHook(() => {
      const canvasRef = useRef<HTMLCanvasElement | null>(document.createElement("canvas"));
      const inputBridgeRef = useRef<HTMLTextAreaElement | null>(
        document.createElement("textarea"),
      );

      return useViewerInput({
        canvasRef,
        inputBridgeRef,
        sendInput,
      });
    });

    result.current.onBridgeKeyDown({
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      nativeEvent: {
        isComposing: false,
      },
    } as never);

    result.current.onBridgeKeyDown({
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      nativeEvent: {
        isComposing: false,
      },
    } as never);

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledWith({
        type: "clipboard",
        action: "paste",
        text: "pasted text",
      });
    });

    expect(sendInput).toHaveBeenCalledWith({
      type: "keyboard",
      key: "Enter",
      modifiers: [],
    });
  });

  it("falls back to keyboard input when clipboard access fails and handles text input", async () => {
    const sendInput = vi.fn();
    Object.assign(navigator, {
      clipboard: {
        readText: vi.fn(async () => {
          throw new Error("clipboard denied");
        }),
      },
    });

    const { result } = renderHook(() => {
      const canvasRef = useRef<HTMLCanvasElement | null>(document.createElement("canvas"));
      const inputBridgeRef = useRef<HTMLTextAreaElement | null>(
        document.createElement("textarea"),
      );

      return useViewerInput({
        canvasRef,
        inputBridgeRef,
        sendInput,
      });
    });

    result.current.onBridgeKeyDown({
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      nativeEvent: {
        isComposing: false,
      },
    } as never);

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledWith({
        type: "keyboard",
        key: "v",
        modifiers: ["Control"],
      });
    });

    const inputTarget = { value: "typed text" };
    result.current.onBridgeInput({
      currentTarget: inputTarget,
    } as never);
    expect(inputTarget.value).toBe("");

    result.current.onBridgeCompositionStart({} as never);
    result.current.onBridgeInput({
      currentTarget: { value: "ignored while composing" },
    } as never);

    const compositionTarget = { value: "ime text" };
    result.current.onBridgeCompositionEnd({
      currentTarget: compositionTarget,
    } as never);

    expect(compositionTarget.value).toBe("");
    expect(sendInput).toHaveBeenCalledWith({
      type: "clipboard",
      action: "paste",
      text: "typed text",
    });
    expect(sendInput).toHaveBeenCalledWith({
      type: "clipboard",
      action: "paste",
      text: "ime text",
    });
  });
});
