import { useLocation } from "react-router-dom";
import { RuntimeStatusPanel } from "../../../components/runtime-status-panel";
import { DiagnosticLogEntry } from "../../../components/diagnostic-log-entry";
import { SystemMonitorPage } from "../../../pages/system-monitor-page";
import { DevResourcesPage } from "../../../pages/dev-resources-page";
import { CodexQuotaProvider } from "../../codex-quota/provider";
import { useSettingsTarget } from "../target-context";
import { SettingsTabs } from "../tabs";
export default function Status() {
  const t = useSettingsTarget(),
    section =
      new URLSearchParams(useLocation().search).get("section") ?? "runtime";
  return (
    <>
      <SettingsTabs
        items={[
          ["runtime", "运行状态"],
          ["resources", "系统资源"],
          ["dev", "开发资源"],
          ["quota", "Codex 额度"],
          ["logs", "日志"],
        ]}
        active={section}
      />
      {section === "resources" ? (
        <SystemMonitorPage embedded />
      ) : section === "dev" ? (
        <DevResourcesPage
          embedded
          apiBase={t.apiBase}
          token={t.auth.token!}
          activeConnectionId={t.connectionId}
          connectionGeneration={t.generation}
          connectionName={t.connection?.name}
          onAuthExpired={t.auth.clearToken}
        />
      ) : section === "quota" ? (
        <CodexQuotaProvider
          embedded
          apiBase={t.apiBase}
          token={t.auth.token}
          connectionName={t.connection?.name ?? "当前电脑"}
          onUnauthorized={t.auth.clearToken}
        >
          {null}
        </CodexQuotaProvider>
      ) : section === "logs" ? (
        <DiagnosticLogEntry
          embedded
          open
          apiBase={t.apiBase}
          token={t.auth.token!}
          onOpenChange={() => {}}
        />
      ) : (
        <RuntimeStatusPanel embedded apiBase={t.apiBase} token={t.auth.token} />
      )}
    </>
  );
}
