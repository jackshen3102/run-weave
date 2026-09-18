# iOS local preview fixtures

- Backend integration: `pnpm --filter @runweave/backend exec tsx ../scripts/verify/browser-local/verify.mts`.
  Starts real isolated HTTP/TCP/WS listeners with the production auth, upgrade router and tunnel service;
  it does not substitute for a complete Backend or native UI acceptance. Closes its own listeners in finally.
- TLS integration: `node scripts/verify/browser-local/verify-tls.mjs`. Generates disposable fixture certificates;
  only the verifier child receives its test CA via `NODE_EXTRA_CA_CERTS`. Host trust settings stay unchanged.
- Complete Backend protocol acceptance:
  `node scripts/verify/browser-local/verify-backend.mjs <baseURL> <devSessionId> <auth-store-path> <caseId>`.
  Supports IOSLOCALSAFE-002, 012, 013 and 017; verifies the running Dev Session identity before login,
  keeps credentials in memory, and creates/deletes its own project, terminals and App sessions.
  The reported result covers protocol assertions and target sockets, not native UI or internal queue/timer instrumentation.
- Native lifecycle fixture: `node scripts/verify/browser-local/lifecycle-fixture.mjs <evidence-directory>`.
  Manifest contains loopback page/control ports. The page exercises relative redirects, iframe/new-window navigation,
  Cookie/LocalStorage/IndexedDB, delayed requests and counted POSTs. Control `/release` releases pending responses;
  `/cut` ends page connections. It does not exercise CacheStorage or periodic storage writes.
- Owned fault gateway:
  `node scripts/verify/browser-local/fault-gate.mjs <baseURL> <devSessionId> <evidence-directory> [port] [controlPort]`.
  Use an isolated HTTP Dev Session; the gateway forwards its authentication unchanged and binds only loopback.
  Control `/mode/404`, `/mode/503`, `/mode/version`, `/mode/delay` and `/mode/normal` affect capabilities only;
  `/release` completes delayed capabilities, and `/cut` closes local-preview WS connections only.
  Inspect control `/` for counts. This is a fault-injection fixture, not a production Backend entry.
  After native cleanup, terminate only the manifest PIDs of fixtures owned by this task.
- Page fixture: `node scripts/verify/browser-local/page-fixture.mjs <evidence-directory>`.
  Only binds computer 127.0.0.1. Manifest records PID, port, runId and 8 MiB digest; events omit credentials.
  HTTP page exercises CSS/JS, relative API, POST, large data, WS and absolute localhost rejection.
  Terminate only its manifest PID after native acceptance.
- Vite fixture: copy `vite-fixture` to a task-owned temporary directory, then run
  `node frontend/node_modules/vite/bin/vite.js <fixture-copy> --host 127.0.0.1 --port <free-port> --strictPort`.
  Uses the repository-pinned Vite (validated with 6.4.1), without an explicit HMR host.
  Edit only that copy's `value.js`; the device must update without incrementing the page load counter.
- P0 probe: `node scripts/verify/browser-local/proxy-probe.mjs <computer-LAN-IP> <evidence-directory>`.
  The Debug-only `--native-browser-proxy-probe --browser-proxy-config <manifest-configURL>` entry tests public WebKit proxy APIs;
  this probe deliberately has no production Backend authentication and is not a product entry test.

Product acceptance contracts live in `docs/testing/app/ios-local-browser*.testplan.yaml`.
A simulator can access Mac loopback directly: it cannot prove the physical iPhone transport path.
