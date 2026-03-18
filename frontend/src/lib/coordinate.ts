export interface MappedPoint {
  x: number;
  y: number;
}

export function mapClientPointToCanvas(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  canvasWidth: number,
  canvasHeight: number,
): MappedPoint {
  const clampedX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const clampedY = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  const scaleX = canvasWidth / rect.width;
  const scaleY = canvasHeight / rect.height;

  return {
    x: Math.round(clampedX * scaleX),
    y: Math.round(clampedY * scaleY),
  };
}

export function extractKeyboardModifiers(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): string[] {
  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  return modifiers;
}
