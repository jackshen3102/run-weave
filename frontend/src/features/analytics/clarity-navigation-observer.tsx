import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { updateClarityScreen } from "./clarity";
import { classifyAnalyticsScreen } from "./screen-classification";

export function ClarityNavigationObserver({ routes, pendingElement }: {
  routes: ReactNode;
  pendingElement?: ReactNode;
}) {
  const { pathname } = useLocation();
  const screen = classifyAnalyticsScreen(routes, pathname, pendingElement);

  useEffect(() => {
    updateClarityScreen(screen);
    return () => updateClarityScreen(null);
  }, [screen]);
  return null;
}
