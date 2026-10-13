import { useLocation } from "react-router-dom";
import { ConfigurationPanel } from "../../configuration/panel";
import { TerminalAgentTeamModelConfigDialog } from "../../../components/terminal/agent-team/model-config-dialog";
import { useSettingsTarget } from "../target-context";
import { SettingsTabs } from "../tabs";
export default function Advanced() {
  const target = useSettingsTarget(),
    section =
      new URLSearchParams(useLocation().search).get("section") ?? "models";
  return (
    <>
      <SettingsTabs
        items={[
          ["models", "默认角色模型"],
          ["configuration", "服务配置"],
        ]}
        active={section}
      />
      {section === "configuration" ? (
        <ConfigurationPanel
          embedded
          apiBase={target.apiBase}
          token={target.auth.token}
          onAuthExpired={target.auth.clearToken}
        />
      ) : (
        <TerminalAgentTeamModelConfigDialog
          onAuthExpired={target.auth.clearToken}
          embedded
          open
          apiBase={target.apiBase}
          token={target.auth.token!}
          onOpenChange={() => {}}
        />
      )}
    </>
  );
}
