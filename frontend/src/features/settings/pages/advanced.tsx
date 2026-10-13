import { ConfigurationPanel } from "../../configuration/panel";
import { useSettingsTarget } from "../target-context";

export default function Advanced() {
  const target = useSettingsTarget();
  return (
    <ConfigurationPanel
      embedded
      apiBase={target.apiBase}
      token={target.auth.token}
      onAuthExpired={target.auth.clearToken}
    />
  );
}
