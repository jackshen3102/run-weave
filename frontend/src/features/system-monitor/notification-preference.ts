import { create } from "zustand";
const key = "runweave:resource-mac-notifications";
function read() {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}
export const useNotificationPreference = create<{
  enabled: boolean;
  setEnabled: (value: boolean) => void;
}>((set) => ({
  enabled: read(),
  setEnabled: (value) => {
    localStorage.setItem(key, String(value));
    set({ enabled: value });
  },
}));
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null)
    useNotificationPreference.setState({ enabled: read() });
});
