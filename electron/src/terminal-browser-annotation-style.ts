export const TERMINAL_BROWSER_ANNOTATION_STYLE = `
#runweave-browser-annotation-root * { box-sizing: border-box; }
.rw-annotation-hover, .rw-annotation-lock {
  position: fixed;
  border: 2px solid #1494ff;
  background: rgba(20, 148, 255, 0.08);
  border-radius: 2px;
  pointer-events: none;
  box-shadow: 0 0 0 1px rgba(2, 6, 23, 0.5);
}
.rw-annotation-lock { border-width: 3px; }
.rw-annotation-marker {
  position: fixed;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 3px solid #ffffff;
  background: #1494ff;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  pointer-events: auto;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
}
.rw-annotation-preview {
  position: fixed;
  max-width: 260px;
  min-height: 48px;
  border-radius: 22px;
  background: #2d2d2d;
  color: #ffffff;
  padding: 13px 18px;
  pointer-events: none;
  box-shadow: 0 16px 50px rgba(0, 0, 0, 0.34);
  font: 18px/1.25 ui-sans-serif, system-ui, sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rw-annotation-editor {
  position: fixed;
  width: min(420px, calc(100vw - 24px));
  min-height: 52px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  background: #2d2d2d;
  color: #e2e8f0;
  padding: 8px 8px 8px 12px;
  pointer-events: auto;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.42);
  display: flex;
  align-items: center;
  gap: 10px;
}
.rw-annotation-tools {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #b8b8b8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font: 18px/1 ui-sans-serif, system-ui, sans-serif;
}
.rw-annotation-tools:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
.rw-annotation-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  border: 0;
  background: transparent;
  color: #f8fafc;
  padding: 0;
  font: 16px/1.3 ui-sans-serif, system-ui, sans-serif;
  outline: none;
}
.rw-annotation-input::placeholder { color: rgba(248, 250, 252, 0.48); }
.rw-annotation-send {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 999px;
  background: #e5e7eb;
  color: #111827;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 22px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.rw-annotation-send:disabled { opacity: 0.45; cursor: default; }
.rw-annotation-menu {
  position: fixed;
  min-width: 130px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background: #2f2f2f;
  color: #ffffff;
  padding: 6px;
  pointer-events: auto;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
}
.rw-annotation-menu[hidden] { display: none; }
.rw-annotation-menu button {
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  font: 15px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.rw-annotation-menu button:hover { background: rgba(255, 255, 255, 0.08); }
.rw-annotation-shortcut {
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.88);
  padding: 4px 8px;
  font-size: 13px;
}
.rw-annotation-edit-actions {
  display: none;
}
.rw-annotation-editor.rw-annotation-editor-editing {
  min-height: 156px;
  border-radius: 24px;
  align-items: flex-start;
  padding: 22px 22px 18px 22px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  grid-template-rows: minmax(44px, 1fr) auto;
  gap: 12px 16px;
}
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-send,
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-menu {
  display: none;
}
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-tools {
  margin-top: 3px;
}
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-input {
  height: auto;
  min-height: 44px;
  align-self: start;
}
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-edit-actions {
  grid-column: 1 / 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-edit-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rw-annotation-edit-delete,
.rw-annotation-edit-cancel,
.rw-annotation-edit-save {
  height: 44px;
  border: 0;
  border-radius: 999px;
  padding: 0 18px;
  font: 18px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.rw-annotation-edit-delete {
  width: 44px;
  padding: 0;
  background: transparent;
  color: #ffffff;
  font-size: 24px;
}
.rw-annotation-edit-delete:hover,
.rw-annotation-edit-cancel:hover {
  background: rgba(255, 255, 255, 0.08);
}
.rw-annotation-edit-cancel {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #ffffff;
}
.rw-annotation-edit-save {
  background: #ffffff;
  color: #1f2937;
}

`;
