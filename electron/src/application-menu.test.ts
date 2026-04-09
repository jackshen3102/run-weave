import assert from "node:assert/strict";
import test from "node:test";
import { buildApplicationMenuTemplate } from "./application-menu.js";

test("adds a New Window action with a cross-platform accelerator", () => {
  let opened = 0;
  const template = buildApplicationMenuTemplate({
    platform: "darwin",
    onNewWindow: () => {
      opened += 1;
    },
  });

  const fileMenu = template.find((item) => item.label === "File");
  assert.ok(fileMenu);
  assert.ok(Array.isArray(fileMenu.submenu));

  const newWindowItem = fileMenu.submenu.find(
    (item) => "label" in item && item.label === "New Window",
  );
  assert.ok(newWindowItem);
  assert.equal(newWindowItem.accelerator, "CmdOrCtrl+Shift+N");
  assert.equal(typeof newWindowItem.click, "function");

  newWindowItem.click?.(
    {} as never,
    {} as never,
    {} as never,
  );
  assert.equal(opened, 1);
});

test("includes the macOS app menu only on darwin", () => {
  const macTemplate = buildApplicationMenuTemplate({
    platform: "darwin",
    onNewWindow: () => undefined,
  });
  const windowsTemplate = buildApplicationMenuTemplate({
    platform: "win32",
    onNewWindow: () => undefined,
  });

  assert.equal(macTemplate[0]?.role, "appMenu");
  assert.notEqual(windowsTemplate[0]?.role, "appMenu");
});
