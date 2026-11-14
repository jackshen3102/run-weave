# Browser annotation runtime

Pure DOM runtime and styles shared by Electron Browser injection and the terminal HTML review iframe. This package contains no Electron, React, IPC, file access or terminal routing. `runtime.js` serializes the page editor, selectors and numbered markers; `target-runtime.js` serializes DOM evidence helpers.

The existing Browser adapter retains polling, screenshots and submission. HTML review enables bounded comments and change events, then transports untrusted state over its own per-document MessagePort. A page submit request only opens the host panel. Shared DTOs remain in `packages/shared`.

Validate through the two consumers' typecheck/build, `pnpm architecture:check`, and the real Browser/HTML review cases in `docs/testing/terminal/visual-plan-review.testplan.yaml`. No unit tests are added.
