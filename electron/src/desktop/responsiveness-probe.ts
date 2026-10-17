// Runs in a separate JavaScript world. Collect state/counts, never input text or URLs.
export const responsivenessProbe = `(() => {
  const key = '__runweaveResponsiveness';
  if (!globalThis[key]) {
    const counts = { pointer: 0, key: 0 };
    document.addEventListener('pointerdown', () => counts.pointer++, { capture: true, passive: true });
    document.addEventListener('keydown', () => counts.key++, { capture: true, passive: true });
    globalThis[key] = counts;
  }
  const body = document.body;
  const active = document.activeElement;
  return {
    focused: document.hasFocus(), visible: document.visibilityState === 'visible',
    bodyPointerBlocked: !!body && getComputedStyle(body).pointerEvents === 'none',
    inert: !!document.querySelector('[inert]'),
    dialog: !!document.querySelector('[role="dialog"]'),
    menu: !!document.querySelector('[role="menu"]'),
    pendingOverlay: !!document.querySelector('[data-native-overlay-pending]'),
    activeInput: !!active && (active.matches('input,textarea') || active.isContentEditable),
    pointerCount: globalThis[key].pointer, keyCount: globalThis[key].key
  };
})()`;
