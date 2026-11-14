import type { WebContents } from "electron";

const leases = new WeakMap<WebContents, { count: number; throttling: boolean }>();

/** Keep hidden pages interactive while CDP or a capture owns their renderer. */
export function acquireTerminalBrowserRendering(contents: WebContents): () => void {
  let lease = leases.get(contents);
  if (!lease) {
    lease = { count: 0, throttling: contents.getBackgroundThrottling() };
    contents.setBackgroundThrottling(false);
    leases.set(contents, lease);
  }
  lease.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.count > 0) return;
    leases.delete(contents);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(lease.throttling);
  };
}
