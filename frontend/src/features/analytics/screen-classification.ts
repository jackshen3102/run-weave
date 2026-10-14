import { isValidElement, type ReactNode } from "react";
import { createRoutesFromChildren, matchRoutes, Navigate } from "react-router-dom";

export type AnalyticsScreen = string;

// Read the same declarations as <Routes>; never classify URL parameter values.
export function classifyAnalyticsScreen(
  routes: ReactNode,
  pathname: string,
  pendingElement?: ReactNode,
): AnalyticsScreen | null {
  const matches = matchRoutes(createRoutesFromChildren(routes), pathname);
  const route = matches?.at(-1)?.route;
  if (!route || route.path?.includes("*")) return null;
  const element = route.element;
  if (element === pendingElement || (isValidElement(element) && element.type === Navigate)) return null;

  // Explicit names preserve historical labels and identify externally rendered shells.
  const screen: unknown = route.handle?.analyticsScreen;
  if (typeof screen === "string") return screen;
  if (element == null) return null;

  return matches?.flatMap(({ route: match }) => (match.path ?? "").split("/"))
    .filter((segment) => segment && !segment.startsWith(":"))
    .map((segment) => segment.replace(/\?$/u, "").replace(/-/gu, "_"))
    .join("_") || null;
}
