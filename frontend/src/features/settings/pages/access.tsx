import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ChangePasswordForm } from "../../../components/terminal/workspace/change-password-dialog";
import { MobileLoginDialog } from "../../mobile-login/mobile-login-dialog";
import { useMobileLogin } from "../../mobile-login/use-mobile-login";
import { useSettingsTarget } from "../target-context";
import { SettingsTabs } from "../tabs";
import { useSettingsDraft } from "../edit-session";
function Phone() {
  const t = useSettingsTarget(),
    c = useMobileLogin(t.connection!, t.auth.token!, t.auth.clearToken);
  const { open, close } = c;
  useEffect(() => {
    void open();
    return close;
  }, [open, close]);
  useSettingsDraft(
    false,
    (c.busy && c.status?.state === "pending_approval") ||
      (!!c.status &&
        ["approved", "issuing", "issued"].includes(c.status.state)),
  );
  return (
    <MobileLoginDialog
      embedded
      controller={c}
      connectionName={c.connectionName}
    />
  );
}
export default function Access() {
  const t = useSettingsTarget(),
    section =
      new URLSearchParams(useLocation().search).get("section") ?? "password";
  return (
    <>
      <SettingsTabs
        items={[
          ["password", "修改密码"],
          ["mobile", "连接手机"],
        ]}
        active={section}
      />
      {section === "mobile" ? (
        t.connection ? (
          <Phone />
        ) : (
          <p>请在桌面应用中选择电脑后连接手机。</p>
        )
      ) : (
        <ChangePasswordForm
          embedded
          apiBase={t.apiBase}
          token={t.auth.token!}
          onAuthExpired={t.auth.clearToken}
        />
      )}
    </>
  );
}
