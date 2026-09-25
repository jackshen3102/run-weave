export type OverlayPolicy = "window" | "intersection";
interface Rect { x: number; y: number; width: number; height: number }
interface Layer { element: HTMLElement; policy: OverlayPolicy }
const layers = new Set<Layer>();
const listeners = new Set<() => void>();
let viewport: Rect | null = null;
let suppressed = false;
let ready = true;
let frame: number | null = null;

export const getOverlaySuppressed = () => suppressed;
export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function overlaps(a: DOMRect, b: Rect): boolean {
  return a.right > b.x && a.left < b.x + b.width && a.bottom > b.y && a.top < b.y + b.height;
}
function running(element: HTMLElement): boolean {
  return element.getAnimations().some((animation) =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
}
function present(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if (element instanceof HTMLDialogElement && !element.open) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || !element.getClientRects().length) return false;
  return element.dataset.state !== "closed" || running(element);
}
function applyReadiness(): void {
  for (const { element } of layers) {
    element.toggleAttribute("data-native-overlay-pending", suppressed && !ready);
  }
}
export function setOverlayReady(value: boolean): void {
  ready = value;
  applyReadiness();
}
export function measureOverlays(): void {
  const next = viewport !== null && [...layers].some(({ element, policy }) =>
    present(element) && (policy === "window" || overlaps(element.getBoundingClientRect(), viewport!)));
  if (next !== suppressed) {
    suppressed = next;
    if (next) ready = false;
    applyReadiness();
    for (const listener of listeners) listener();
  } else {
    applyReadiness();
  }
}
export function scheduleOverlayMeasure(): void {
  if (frame !== null || layers.size === 0) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    measureOverlays();
    // Only finite transitions keep measuring; static popovers do not poll.
    if ([...layers].some(({ element }) => running(element))) scheduleOverlayMeasure();
  });
}
export function setOverlayViewport(next: Rect | null): void {
  viewport = next;
  measureOverlays();
}
export function registerOverlay(element: HTMLElement, policy: OverlayPolicy): () => void {
  const layer = { element, policy };
  layers.add(layer);
  const changed = () => { measureOverlays(); scheduleOverlayMeasure(); };
  const resize = new ResizeObserver(changed);
  resize.observe(element);
  const mutations = new MutationObserver(changed);
  // Popper changes the wrapper transform without resizing Content.
  for (const target of [element, element.parentElement]) {
    if (target) mutations.observe(target, { attributes: true, attributeFilter: ["data-state", "aria-hidden", "open", "hidden", "class", "style"] });
  }
  element.addEventListener("animationstart", changed);
  element.addEventListener("animationend", changed);
  element.addEventListener("transitionrun", changed);
  element.addEventListener("transitionend", changed);
  if (layers.size === 1) {
    window.addEventListener("resize", scheduleOverlayMeasure);
    window.addEventListener("scroll", scheduleOverlayMeasure, true);
  }
  changed();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    element.removeEventListener("animationstart", changed);
    element.removeEventListener("animationend", changed);
    element.removeEventListener("transitionrun", changed);
    element.removeEventListener("transitionend", changed);
    element.removeAttribute("data-native-overlay-pending");
    layers.delete(layer);
    // Allow a replacement layer to register in the same React commit before restoring.
    scheduleOverlayMeasure();
    if (layers.size === 0) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = null; measureOverlays(); });
      window.removeEventListener("resize", scheduleOverlayMeasure);
      window.removeEventListener("scroll", scheduleOverlayMeasure, true);
    }
  };
}
