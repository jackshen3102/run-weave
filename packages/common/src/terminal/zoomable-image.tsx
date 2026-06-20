import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useEffect,
  useRef,
  useState,
} from "react";

interface Size {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface Transform extends Point {
  scale: number;
}

type ZoomableImageMode = "fit" | "actual" | "custom";

export interface ZoomableImageProps {
  src: string;
  alt: string;
  title?: string;
  className?: string;
  toolbarPlacement?: "top" | "bottom";
  fullscreen?: boolean;
  fullscreenEnabled?: boolean;
  onRequestFullscreen?: () => void;
  onCloseFullscreen?: () => void;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const ZOOM_STEP = 1.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getMidpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function getScaleBounds(fitScale: number): { min: number; max: number } {
  return {
    min: Math.min(MIN_SCALE, fitScale),
    max: Math.max(MAX_SCALE, fitScale * 6, 1),
  };
}

function getFitScale(containerSize: Size, imageSize: Size): number {
  if (
    containerSize.width <= 0 ||
    containerSize.height <= 0 ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return 1;
  }

  return Math.min(
    containerSize.width / imageSize.width,
    containerSize.height / imageSize.height,
  );
}

function clampTransform(
  nextTransform: Transform,
  containerSize: Size,
  imageSize: Size,
  fitScale: number,
): Transform {
  const bounds = getScaleBounds(fitScale);
  const scale = clamp(nextTransform.scale, bounds.min, bounds.max);
  const scaledWidth = imageSize.width * scale;
  const scaledHeight = imageSize.height * scale;
  const maxX = Math.max(0, (scaledWidth - containerSize.width) / 2);
  const maxY = Math.max(0, (scaledHeight - containerSize.height) / 2);

  return {
    scale,
    x: clamp(nextTransform.x, -maxX, maxX),
    y: clamp(nextTransform.y, -maxY, maxY),
  };
}

function getPointFromEvent(
  event: Pick<PointerEvent<HTMLElement>, "clientX" | "clientY">,
  element: HTMLElement,
): Point {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  };
}

function zoomAroundPoint(
  transform: Transform,
  nextScale: number,
  point: Point,
): Transform {
  const imagePoint = {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  };

  return {
    scale: nextScale,
    x: point.x - imagePoint.x * nextScale,
    y: point.y - imagePoint.y * nextScale,
  };
}

function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function ToolbarButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: ReactNode;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={title}
      className="rw-zoomable-image__button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
}

export function ZoomableImage({
  src,
  alt,
  title,
  className,
  toolbarPlacement = "top",
  fullscreen = false,
  fullscreenEnabled = true,
  onRequestFullscreen,
  onCloseFullscreen,
}: ZoomableImageProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<Transform>({ scale: 1, x: 0, y: 0 });
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const dragStartRef = useRef<{
    point: Point;
    transform: Transform;
  } | null>(null);
  const pinchStartRef = useRef<{
    distance: number;
    midpoint: Point;
    transform: Transform;
  } | null>(null);
  const lastTapRef = useRef(0);
  const [containerSize, setContainerSize] = useState<Size>({
    width: 0,
    height: 0,
  });
  const [imageSize, setImageSize] = useState<Size>({ width: 0, height: 0 });
  const [mode, setMode] = useState<ZoomableImageMode>("fit");
  const [transform, setTransform] = useState<Transform>({
    scale: 1,
    x: 0,
    y: 0,
  });

  const fitScale = getFitScale(containerSize, imageSize);
  const scaleBounds = getScaleBounds(fitScale);
  const canZoomOut = transform.scale > scaleBounds.min;
  const canZoomIn = transform.scale < scaleBounds.max;

  const applyTransform = (nextTransform: Transform) => {
    const clampedTransform = clampTransform(
      nextTransform,
      containerSize,
      imageSize,
      fitScale,
    );
    transformRef.current = clampedTransform;
    setTransform(clampedTransform);
  };

  const setFitMode = () => {
    setMode("fit");
    applyTransform({ scale: fitScale || 1, x: 0, y: 0 });
  };

  const setActualMode = () => {
    setMode("actual");
    applyTransform({ scale: 1, x: 0, y: 0 });
  };

  const zoomBy = (factor: number, point?: Point) => {
    setMode("custom");
    const baseTransform = transformRef.current;
    const nextScale = baseTransform.scale * factor;
    applyTransform(
      point
        ? zoomAroundPoint(baseTransform, nextScale, point)
        : { ...baseTransform, scale: nextScale },
    );
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const syncSize = () => {
      setContainerSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };

    syncSize();
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(viewport);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (fullscreen) {
      viewportRef.current?.focus({ preventScroll: true });
    }
  }, [fullscreen]);

  useEffect(() => {
    pointersRef.current.clear();
    dragStartRef.current = null;
    pinchStartRef.current = null;
    setMode("fit");
    transformRef.current = { scale: 1, x: 0, y: 0 };
    setTransform({ scale: 1, x: 0, y: 0 });
    setImageSize({ width: 0, height: 0 });
  }, [src]);

  useEffect(() => {
    if (imageSize.width <= 0 || imageSize.height <= 0) {
      return;
    }

    if (mode === "fit") {
      const nextTransform = {
        scale: fitScale || 1,
        x: 0,
        y: 0,
      };
      transformRef.current = nextTransform;
      setTransform(nextTransform);
      return;
    }

    if (mode === "actual") {
      const nextTransform = clampTransform(
        { scale: 1, x: 0, y: 0 },
        containerSize,
        imageSize,
        fitScale,
      );
      transformRef.current = nextTransform;
      setTransform(nextTransform);
      return;
    }

    applyTransform(transformRef.current);
  }, [
    containerSize.height,
    containerSize.width,
    fitScale,
    imageSize.height,
    imageSize.width,
    mode,
  ]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getPointFromEvent(event, viewport);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size === 1) {
      dragStartRef.current = {
        point,
        transform: transformRef.current,
      };
      pinchStartRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const points = Array.from(pointersRef.current.values());
      const first = points[0];
      const second = points[1];
      if (!first || !second) {
        return;
      }
      dragStartRef.current = null;
      pinchStartRef.current = {
        distance: getDistance(first, second),
        midpoint: getMidpoint(first, second),
        transform: transformRef.current,
      };
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !pointersRef.current.has(event.pointerId)) {
      return;
    }

    const point = getPointFromEvent(event, viewport);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && pinchStartRef.current) {
      const points = Array.from(pointersRef.current.values());
      const first = points[0];
      const second = points[1];
      if (!first || !second || pinchStartRef.current.distance <= 0) {
        return;
      }
      const nextMidpoint = getMidpoint(first, second);
      const nextScale =
        pinchStartRef.current.transform.scale *
        (getDistance(first, second) / pinchStartRef.current.distance);
      const zoomedTransform = zoomAroundPoint(
        pinchStartRef.current.transform,
        nextScale,
        pinchStartRef.current.midpoint,
      );
      setMode("custom");
      applyTransform({
        ...zoomedTransform,
        x: zoomedTransform.x + nextMidpoint.x - pinchStartRef.current.midpoint.x,
        y: zoomedTransform.y + nextMidpoint.y - pinchStartRef.current.midpoint.y,
      });
      return;
    }

    if (dragStartRef.current) {
      setMode("custom");
      applyTransform({
        ...dragStartRef.current.transform,
        x:
          dragStartRef.current.transform.x +
          point.x -
          dragStartRef.current.point.x,
        y:
          dragStartRef.current.transform.y +
          point.y -
          dragStartRef.current.point.y,
      });
    }
  };

  const finishPointerGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointersRef.current.delete(event.pointerId);
    dragStartRef.current = null;
    pinchStartRef.current = null;

    if (pointersRef.current.size === 1) {
      const remainingPoint = Array.from(pointersRef.current.values())[0];
      if (remainingPoint) {
        dragStartRef.current = {
          point: remainingPoint,
          transform: transformRef.current,
        };
      }
    }
  };

  const handleDoubleClick = () => {
    if (mode === "actual") {
      setFitMode();
      return;
    }
    setActualMode();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      finishPointerGesture(event);
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current <= 300) {
      handleDoubleClick();
      lastTapRef.current = 0;
      finishPointerGesture(event);
      return;
    }
    lastTapRef.current = now;
    finishPointerGesture(event);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    event.preventDefault();
    const point = getPointFromEvent(event, viewport);
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomBy(factor, point);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && fullscreen && onCloseFullscreen) {
      event.preventDefault();
      onCloseFullscreen();
      return;
    }

    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      setFitMode();
    } else if (event.key === "1") {
      event.preventDefault();
      setActualMode();
    }
  };

  const rootClassName = [
    "rw-zoomable-image",
    `rw-zoomable-image--toolbar-${toolbarPlacement}`,
    fullscreen ? "rw-zoomable-image--fullscreen" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClassName}>
      <div
        aria-label={title ?? alt}
        className="rw-zoomable-image__viewport"
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onPointerCancel={finishPointerGesture}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        ref={viewportRef}
        role="img"
        tabIndex={0}
      >
        <img
          alt={alt}
          className="rw-zoomable-image__image"
          draggable={false}
          onLoad={(event) => {
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
          src={src}
          style={{
            transform: `translate(calc(-50% + ${transform.x}px), calc(-50% + ${transform.y}px)) scale(${transform.scale})`,
          }}
        />
      </div>
      <div className="rw-zoomable-image__toolbar" role="toolbar">
        {title ? <span className="rw-zoomable-image__title">{title}</span> : null}
        <ToolbarButton
          disabled={!canZoomOut}
          label="-"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          title="Zoom out"
        />
        <span aria-live="polite" className="rw-zoomable-image__zoom">
          {formatZoom(transform.scale)}
        </span>
        <ToolbarButton
          disabled={!canZoomIn}
          label="+"
          onClick={() => zoomBy(ZOOM_STEP)}
          title="Zoom in"
        />
        <ToolbarButton label="Fit" onClick={setFitMode} title="Fit to screen" />
        <ToolbarButton label="1:1" onClick={setActualMode} title="Actual size" />
        <ToolbarButton label="Reset" onClick={setFitMode} title="Reset view" />
        {onRequestFullscreen && fullscreenEnabled && !fullscreen ? (
          <ToolbarButton
            label="[]"
            onClick={onRequestFullscreen}
            title="Open fullscreen"
          />
        ) : null}
        {fullscreen && onCloseFullscreen ? (
          <ToolbarButton label="x" onClick={onCloseFullscreen} title="Close" />
        ) : null}
      </div>
    </div>
  );
}
