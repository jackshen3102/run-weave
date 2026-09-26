/** Device-local data stays scoped to the browser origin / Electron userData.
 * Server settings never enter this adapter; credentials retain their existing
 * local-vs-tab lifetime and backend connection keys.
 */
const localKeys = new Set([
  "viewer.connections", "viewer.auth.connection-auth", "viewer.auth.token",
  "viewer.auth.remembered-credentials", "terminal.browser.headerRules",
  "runweave.terminal.sidecar.width.v1", "runweave.terminal.preview.projects.v1",
  "runweave.terminal.preview.drafts.v1", "viewer.desktop-companion.failure-seen.v1",
  "viewer.terminal.perfLogs", "suiji.accounts.v1", "suiji.endpoint.v1",
  "viewer.remote-project-bindings.v1", "theme",
]);
const localPrefixes = [
  "terminal.browser.headerRules.", "viewer.terminal.worktree-rail-width.",
  "viewer.terminal.worktree-rail-collapsed.", "viewer.terminal.recent.",
  "runweave.prototype-gallery.selection.v1:", "runweave.prototype-gallery.sidebar-collapsed.v1:",
  "viewer.remote-forward.",
];
function registered(key: string, session: boolean): boolean {
  return session ? ["suiji.accounts.v1:production", "suiji.accounts.v1:development"].includes(key)
    : localKeys.has(key) || localPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}
function createDeviceStorage(session: boolean) {
  const storage = () => session ? window.sessionStorage : window.localStorage;
  const assertKey = (key: string) => { if (!registered(key, session)) throw new Error("DEVICE_STORAGE_KEY_UNREGISTERED"); };
  const keys = () => Object.keys(storage()).filter((key) => registered(key, session));
  return {
    getItem(key: string): string | null { assertKey(key); return storage().getItem(key); },
    setItem(key: string, value: string): void { assertKey(key); storage().setItem(key, value); },
    removeItem(key: string): void { assertKey(key); storage().removeItem(key); },
    get length(): number { return keys().length; },
    key(index: number): string | null { return keys()[index] ?? null; },
  };
}
export const deviceStorage = createDeviceStorage(false);
export const deviceSessionStorage = createDeviceStorage(true);
