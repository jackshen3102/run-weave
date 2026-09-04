import type { WebContents } from "electron";

export interface TerminalBrowserAutomationCaptureSource {
  targetId: string;
  webContents: WebContents;
  viewportWidth: number;
  viewportHeight: number;
}

export interface TerminalBrowserAutomationCaptureFrame {
  targetId: string;
  sequence: number;
  captureStartedAt: number;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  bytes: Uint8Array;
  byteLength: number;
}

export interface TerminalBrowserAutomationCaptureStats {
  captureCount: number;
  emittedFrameCount: number;
  duplicateFrameCount: number;
  failureCount: number;
  inFlightCount: number;
  bufferCount: number;
  lastFrameAt: number | null;
  emittedByteCount: number;
}

export interface TerminalBrowserAutomationCaptureRequest {
  source: TerminalBrowserAutomationCaptureSource;
  maxEdge: number;
  fps?: number;
}

export interface TerminalBrowserAutomationCaptureCallbacks {
  onFrame: (frame: TerminalBrowserAutomationCaptureFrame) => void;
  onError?: (targetId: string, error: Error) => void;
}

interface EncodedFrame {
  captureStartedAt: number;
  encoded: Buffer;
  width: number;
  height: number;
}

interface ActiveCapture extends TerminalBrowserAutomationCaptureSource {
  maxEdge: number;
  intervalMs: number;
  sequence: number;
  inFlight: boolean;
  awaitingFrameSequence: number | null;
  captureTimer: NodeJS.Timeout | null;
}

const DEFAULT_FPS = 5;
const JPEG_QUALITY = 60;
// Never let an over-budget capture immediately start another synchronous
// resize/JPEG cycle on Electron's main thread.
const MIN_CAPTURE_COOLDOWN_MS = 50;

function clampFps(value: number | undefined): number {
  return Math.min(15, Math.max(1, value ?? DEFAULT_FPS));
}

function clampMaxEdge(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Capture max edge must be finite");
  }
  return Math.min(1280, Math.max(1, Math.round(value)));
}

function getScaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class TerminalBrowserAutomationCapture {
  private generation = 0;
  private captureCount = 0;
  private emittedFrameCount = 0;
  private failureCount = 0;
  private inFlightCount = 0;
  private lastFrameAt: number | null = null;
  private emittedByteCount = 0;
  private active: ActiveCapture | null = null;

  constructor(
    private readonly callbacks: TerminalBrowserAutomationCaptureCallbacks,
  ) {}

  start(request: TerminalBrowserAutomationCaptureRequest): void {
    this.stop();
    const generation = ++this.generation;
    const fps = clampFps(request.fps);
    const active: ActiveCapture = {
      ...request.source,
      maxEdge: clampMaxEdge(request.maxEdge),
      intervalMs: Math.round(1000 / fps),
      sequence: 0,
      inFlight: false,
      awaitingFrameSequence: null,
      captureTimer: null,
    };
    this.active = active;
    this.scheduleCapturePage(active, generation, 0);
  }

  stop(): void {
    this.generation += 1;
    if (this.active) {
      if (this.active.captureTimer) {
        clearTimeout(this.active.captureTimer);
        this.active.captureTimer = null;
      }
      this.active.awaitingFrameSequence = null;
    }
    this.active = null;
  }

  private scheduleCapturePage(
    active: ActiveCapture,
    generation: number,
    delayMs: number,
  ): void {
    if (generation !== this.generation || this.active !== active) {
      return;
    }
    active.captureTimer = setTimeout(() => {
      active.captureTimer = null;
      void this.capturePage(active, generation);
    }, delayMs);
  }

  private async capturePage(
    active: ActiveCapture,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      this.active !== active ||
      active.webContents.isDestroyed()
    ) {
      return;
    }
    if (active.awaitingFrameSequence !== null) {
      this.scheduleCapturePage(active, generation, active.intervalMs);
      return;
    }
    const captureStartedAt = Date.now();
    active.inFlight = true;
    this.inFlightCount += 1;
    try {
      const image = await active.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: false,
      });
      if (
        generation !== this.generation ||
        this.active !== active ||
        image.isEmpty()
      ) {
        if (image.isEmpty()) {
          this.recordFailure(active, new Error("Captured frame is empty"));
        }
        return;
      }
      const sourceSize = image.getSize();
      const size = getScaledSize(
        sourceSize.width || active.viewportWidth,
        sourceSize.height || active.viewportHeight,
        active.maxEdge,
      );
      const encoded = image
        .resize({ width: size.width, height: size.height, quality: "good" })
        .toJPEG(JPEG_QUALITY);
      if (encoded.byteLength === 0) {
        this.recordFailure(active, new Error("Encoded frame is empty"));
        return;
      }
      this.captureCount += 1;
      this.emitFrame(active, { captureStartedAt, encoded, ...size });
    } catch (error) {
      if (generation === this.generation && this.active === active) {
        this.recordFailure(active, error);
      }
    } finally {
      active.inFlight = false;
      this.inFlightCount -= 1;
      if (generation === this.generation && this.active === active) {
        const elapsed = Date.now() - captureStartedAt;
        this.scheduleCapturePage(
          active,
          generation,
          Math.max(MIN_CAPTURE_COOLDOWN_MS, active.intervalMs - elapsed),
        );
      }
    }
  }

  getStats(): TerminalBrowserAutomationCaptureStats {
    return {
      captureCount: this.captureCount,
      emittedFrameCount: this.emittedFrameCount,
      duplicateFrameCount: 0,
      failureCount: this.failureCount,
      inFlightCount: this.inFlightCount,
      bufferCount:
        this.inFlightCount +
        (this.active?.awaitingFrameSequence != null ? 1 : 0),
      lastFrameAt: this.lastFrameAt,
      emittedByteCount: this.emittedByteCount,
    };
  }

  acknowledge(sequence: number): void {
    const active = this.active;
    if (!active || active.awaitingFrameSequence !== sequence) {
      return;
    }
    active.awaitingFrameSequence = null;
  }

  private emitFrame(active: ActiveCapture, frame: EncodedFrame): void {
    const capturedAt = Date.now();
    const bytes = Uint8Array.from(frame.encoded);
    active.sequence += 1;
    active.awaitingFrameSequence = active.sequence;
    this.emittedFrameCount += 1;
    this.emittedByteCount += bytes.byteLength;
    this.lastFrameAt = capturedAt;
    this.callbacks.onFrame({
      targetId: active.targetId,
      sequence: active.sequence,
      captureStartedAt: frame.captureStartedAt,
      capturedAt,
      width: frame.width,
      height: frame.height,
      mimeType: "image/jpeg",
      bytes,
      byteLength: bytes.byteLength,
    });
  }

  private recordFailure(active: ActiveCapture, error: unknown): void {
    this.failureCount += 1;
    this.callbacks.onError?.(
      active.targetId,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
