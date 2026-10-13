import { useLocation, useNavigate, type Location } from "react-router-dom";
import { useMemoizedFn } from "ahooks";
import type { SettingsPageId } from "./registry";
export function settingsBackground(location: Location): Location | null {
  const value: unknown = location.state?.settingsBackground;
  if (
    !value ||
    typeof value !== "object" ||
    !("pathname" in value) ||
    typeof value.pathname !== "string" ||
    !/^\/(?:terminal|scheduled-tasks|background-runs|system-monitor|dev-resources|activity|evolution|prototypes|connections)(?:\/|$)/u.test(
      value.pathname,
    )
  )
    return null;
  return value as Location;
}
export function useSettingsNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return useMemoizedFn(
    (page: SettingsPageId = "appearance", section?: string) => {
      const params = new URLSearchParams();
      const target = new URLSearchParams(location.search).get("target");
      if (location.pathname.startsWith("/settings") && target)
        params.set("target", target);
      if (section) params.set("section", section);
      navigate(`/settings/${page}${params.size ? `?${params}` : ""}`, {
        state: {
          settingsBackground: location.pathname.startsWith("/settings")
            ? settingsBackground(location)
            : location,
        },
      });
    },
  );
}
