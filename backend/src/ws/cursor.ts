import type { CDPSession } from "playwright";

function normalizeCursor(cursor: string | undefined): string {
  if (!cursor || cursor === "auto") {
    return "default";
  }
  if (cursor.startsWith("url(")) {
    return "default";
  }
  return cursor;
}

export async function resolveCursorAtPoint(
  cdpSession: CDPSession,
  x: number,
  y: number,
): Promise<string> {
  const location = await cdpSession.send("DOM.getNodeForLocation", {
    x,
    y,
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });

  let nodeId =
    typeof location?.nodeId === "number" ? (location.nodeId as number) : null;

  if (!nodeId && typeof location?.backendNodeId === "number") {
    const pushed = await cdpSession.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [location.backendNodeId],
    });
    const pushedNodeId = Array.isArray(pushed?.nodeIds) ? pushed.nodeIds[0] : null;
    nodeId = typeof pushedNodeId === "number" ? pushedNodeId : null;
  }

  if (!nodeId) {
    return "default";
  }

  const computed = await cdpSession.send("CSS.getComputedStyleForNode", {
    nodeId,
  });
  const computedStyle = Array.isArray(computed?.computedStyle)
    ? computed.computedStyle
    : [];
  const cursorEntry = computedStyle.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      "value" in entry &&
      (entry as { name: unknown }).name === "cursor",
  ) as { value?: string } | undefined;

  return normalizeCursor(cursorEntry?.value);
}
