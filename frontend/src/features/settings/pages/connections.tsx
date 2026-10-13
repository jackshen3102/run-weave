import type { SettingsPageProps } from "../types";
import { ConnectionPage } from "../../../components/connection-page";
import { TunnelDrawer } from "../../tunnels/drawer";
import { SettingsTabs } from "../tabs";
import { useLocation, useNavigate } from "react-router-dom";
export default function Connections(props: SettingsPageProps) {
  const location = useLocation(),
    navigate = useNavigate();
  const params = new URLSearchParams(location.search),
    section = params.get("section") ?? "saved";
  if (!window.electronAPI?.isElectron)
    return (
      <p className="text-sm text-muted-foreground">
        连接与 SSH 通道由桌面应用管理。
      </p>
    );
  return (
    <>
      <SettingsTabs
        items={[
          ["saved", "连接"],
          ["hosts", "SSH 主机与通道"],
        ]}
        active={section}
      />
      {section === "hosts" ? (
        <TunnelDrawer embedded />
      ) : (
        <ConnectionPage
          embedded
          onManageTunnels={() => {
            const next = new URLSearchParams(location.search);
            next.set("section", "hosts");
            navigate(`${location.pathname}?${next}`, { state: location.state });
          }}
          connections={props.connections}
          activeId={params.get("target") ?? props.activeConnection?.id ?? null}
          onAdd={props.onAdd}
          onRemove={props.onRemove}
          onEdit={props.onEdit}
          onReconnect={props.onReconnect}
          onSelect={(id) => {
            const next = new URLSearchParams(location.search);
            next.set("target", id);
            navigate(`${location.pathname}?${next}`, { state: location.state });
          }}
        />
      )}
    </>
  );
}
