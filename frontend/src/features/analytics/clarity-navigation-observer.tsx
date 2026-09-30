import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { updateClarityScreen } from "./clarity";
import { classifyAnalyticsScreen } from "./screen-classification";

export function ClarityNavigationObserver({
  isDesktop,
  needsConnection,
  isAuthChecking,
  authenticated,
}: {
  isDesktop: boolean;
  needsConnection: boolean;
  isAuthChecking: boolean;
  authenticated: boolean;
}) {
  const { pathname } = useLocation();
  const candidate = classifyAnalyticsScreen(pathname);
  const visible = candidate === "system_monitor" ||
    (candidate === "connections" ? isDesktop :
      !needsConnection && !isAuthChecking &&
      (candidate === "login" ? !authenticated : authenticated));
  const screen = visible ? candidate : null;

  useEffect(() => {
    updateClarityScreen(screen);
    return () => updateClarityScreen(null);
  }, [screen]);
  return null;
}
