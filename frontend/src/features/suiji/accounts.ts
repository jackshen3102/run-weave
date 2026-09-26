import { deviceStorage, deviceSessionStorage } from "../device-storage";
import type {
  SuijiDesktopState,
  SuijiEnvironment,
  SuijiProfile,
} from "@runweave/shared/suiji/desktop";

export const environmentLabel = (environment: SuijiEnvironment) =>
  environment === "production" ? "正式" : "开发";
const key = "suiji.accounts.v1";
const desktop = () => {
  const bridge = window.electronAPI;
  if (
    !bridge?.loadSuijiState ||
    !bridge.saveSuijiProfile ||
    !bridge.selectSuijiEnvironment
  )
    throw new Error("请更新桌面客户端以启用随记账户保存");
  return bridge;
};
// Web retains tab-scoped tokens. Password persistence is a desktop capability.
export async function loadAccounts(): Promise<SuijiDesktopState> {
  if (window.electronAPI?.isElectron) return desktop().loadSuijiState!();
  const saved = deviceStorage.getItem(key);
  const state: SuijiDesktopState = saved
    ? JSON.parse(saved)
    : {
        active: "production",
        profiles: {
          production: {
            endpoint: deviceStorage.getItem("suiji.endpoint.v1") ?? "",
            username: "",
          },
          development: { endpoint: "http://127.0.0.1:4783", username: "" },
        },
      };
  for (const env of ["production", "development"] as const) {
    const session = deviceSessionStorage.getItem(`${key}:${env}`);
    if (session) state.profiles[env].session = JSON.parse(session);
  }
  return state;
}
export async function saveProfile(
  environment: SuijiEnvironment,
  profile: SuijiProfile,
) {
  if (window.electronAPI?.isElectron)
    return desktop().saveSuijiProfile!(environment, profile);
  const state = await loadAccounts();
  state.profiles[environment] = profile;
  if (profile.session)
    deviceSessionStorage.setItem(
      `${key}:${environment}`,
      JSON.stringify(profile.session),
    );
  else deviceSessionStorage.removeItem(`${key}:${environment}`);
  saveWebMetadata(state);
}
function saveWebMetadata(state: SuijiDesktopState) {
  deviceStorage.setItem(
    key,
    JSON.stringify({
      ...state,
      profiles: Object.fromEntries(
        Object.entries(state.profiles).map(([env, value]) => [
          env,
          { endpoint: value.endpoint, username: value.username },
        ]),
      ),
    }),
  );
}
export async function selectEnvironment(environment: SuijiEnvironment) {
  if (window.electronAPI?.isElectron)
    return desktop().selectSuijiEnvironment!(environment);
  const state = await loadAccounts();
  state.active = environment;
  saveWebMetadata(state);
}
