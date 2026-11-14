import { BaseWindow, BrowserWindow } from "electron";
import { borrowTerminalBrowserPresentation } from "../view/presentation.js";
import { relayoutTerminalBrowserViewport } from "../device/viewport-layout.js";
import { getTerminalBrowserEntryByTargetId } from "../view/index.js";
import { acquireTerminalBrowserRendering } from "../view/rendering.js";

export function attachCaptureSurface(
  windowId: number,
  targetId: string,
  width: number,
  height: number,
): (() => void) | null {
  const owner = BrowserWindow.fromId(windowId);
  const entry = getTerminalBrowserEntryByTargetId(targetId)?.entry;
  if (!owner || !entry) {
    return null;
  }
  const currentBounds = entry.view.getBounds();
  const releaseRendering = acquireTerminalBrowserRendering(entry.view.webContents);
  if (entry.attached && currentBounds.width > 0 && currentBounds.height > 0) {
    return releaseRendering;
  }
  const releasePresentation = borrowTerminalBrowserPresentation(owner, entry);
  if (entry.visible) {
    entry.viewportView.setVisible(false);
    entry.visible = false;
  }
  const previousViewportBounds = entry.viewportView.getBounds();
  const previousContentBounds = entry.view.getBounds();
  const wasAttached = entry.attached;
  const hasCompositorSize =
    previousContentBounds.width > 0 && previousContentBounds.height > 0;
  if (wasAttached && hasCompositorSize) {
    return () => {
      releaseRendering();
      releasePresentation(() => relayoutTerminalBrowserViewport(entry));
    };
  }
  if (wasAttached) {
    // Target.createTarget can attach a Browser tab before the Browser tool has
    // supplied bounds. Reparent that 0x0 view so bounds are applied after its
    // capture parent exists; resizing it while hidden in-place is ineffective.
    owner.contentView.removeChildView(entry.viewportView);
    entry.attached = false;
  }
  // An unattached or hidden WebContentsView has no compositor surface, so
  // capturePage returns an empty image. Give it a focus-free BaseWindow behind
  // the owning window. BaseWindow adds no extra webContents target of its own,
  // and matching the owner's bounds keeps the host fully covered.
  const ownerBounds = owner.getBounds();
  const host = new BaseWindow({
    show: false,
    ...ownerBounds,
    focusable: false,
    skipTaskbar: true,
  });
  host.contentView.addChildView(entry.viewportView);
  // Bounds must be applied after the nested view is attached. Electron does
  // not propagate a pre-attachment resize to this WebContentsView, leaving its
  // renderer viewport at 0x0 and every capture empty.
  entry.viewportView.setBounds({ x: 0, y: 0, width, height });
  entry.view.setBounds({ x: 0, y: 0, width, height });
  entry.viewportView.setVisible(true);
  const keepBehindOwner = () => {
    if (!host.isDestroyed() && !owner.isDestroyed()) {
      host.setBounds(owner.getBounds());
      owner.moveTop();
    }
  };
  owner.on("move", keepBehindOwner);
  owner.on("resize", keepBehindOwner);
  host.showInactive();
  owner.moveTop();
  return () => {
    if (!owner.isDestroyed()) {
      owner.removeListener("move", keepBehindOwner);
      owner.removeListener("resize", keepBehindOwner);
    }
    if (!host.isDestroyed()) {
      host.contentView.removeChildView(entry.viewportView);
      host.destroy();
    }
    entry.attached = false;
    if (
      wasAttached &&
      !owner.isDestroyed() &&
      !entry.view.webContents.isDestroyed()
    ) {
      owner.contentView.addChildView(entry.viewportView);
      entry.attached = true;
    }
    releaseRendering();
    entry.viewportView.setVisible(false);
    entry.viewportView.setBounds(previousViewportBounds);
    entry.view.setBounds(previousContentBounds);
    releasePresentation(() => relayoutTerminalBrowserViewport(entry));
  };
}
