import { verifyWindowsHostedUpgrade } from "./windows-host-upgrade.mjs";
// Real authenticated HTTP + WebSocket + ConPTY integration, against an installed Server.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export async function verifyWindowsTerminal(url, token, cwd, lifecycle) {
  async function api(route, body, method = "POST") {
    const response = await fetch(`${url}/api/terminal/${route}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  }
  const project = await api("project", { name: "Windows PTY verification", path: cwd });
  let socket, id, browserBridge, browserBindingId;
  const gatewayKey = randomBytes(32).toString("hex");
  const desktopIdentity = { protocolVersion: 2, desktopId: "registry-desktop", hostId: "registry-host", generation: 1 };
  async function registerBrowserCandidate() {
    if (!browserBridge) {
      browserBridge = createServer((request, response) => {
        if (request.url !== "/check" || request.headers["x-runweave-gateway-key"] !== gatewayKey) {
          response.writeHead(403); response.end(); return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(desktopIdentity));
      });
      await new Promise(resolve => browserBridge.listen(0, "127.0.0.1", resolve));
    }
    const response = await fetch(`${url}/api/desktop-browser/bindings`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...desktopIdentity, reversePort: browserBridge.address().port, gatewayKey }),
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, `Fixture Browser candidate registration failed (${response.status})`);
    browserBindingId = (await response.json()).id;
  }
  try {
    const created = await api("session", { projectId: project.projectId, command: "powershell.exe", args: [] });
    id = created.terminalSessionId;
    const session = await api(`session/${id}`, undefined, "GET");
    assert(session.command.toLowerCase().endsWith("powershell.exe"), "Explicit PowerShell override was not preserved");
    assert(!session.tmuxSessionName, "Windows unexpectedly created tmux");
    const nonce = randomBytes(6).toString("hex");
    async function connect() {
      const { ticket } = await api(`session/${id}/ws-ticket`, {});
      const ws = new WebSocket(`${url.replace("http", "ws")}/ws/terminal?terminalSessionId=${id}&token=${encodeURIComponent(ticket)}&resizeMode=ordered`);
      let output = "", liveOutput = "", connected = false, failure, size;
      ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (["output", "snapshot"].includes(message.type)) output += message.data;
        if (message.type === "output") liveOutput += message.data;
        if (message.type === "connected") connected = message.runtimeKind === "pty";
        if (message.type === "error") failure = message.message;
        if (message.type === "resize") size = `${message.cols}x${message.rows}`;
      });
      ws.addEventListener("error", () => { failure = "WebSocket error"; });
      async function wait(predicate, label, timeout = 15_000) {
        const deadline = Date.now() + timeout;
        while (!predicate()) {
          assert(!failure, failure);
          assert(Date.now() < deadline, `Timed out: ${label}; terminal tail: ${output.slice(-1000)}`);
          await sleep(50);
        }
      }
      await wait(() => connected, "PTY connected");
      // A unique prompt cannot be confused with an old snapshot or command echo.
      // eslint-disable-next-line no-control-regex -- Normalize ConPTY cursor/color escapes before observing the prompt.
      const visible = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
      return {
        ws,
        send: message => ws.send(JSON.stringify(message)),
        waitPrompt: () => wait(() => visible(output).includes(`RW_PROMPT_${nonce}>`), "PowerShell prompt installed"),
        async interrupt() {
          const since = liveOutput.length;
          ws.send(JSON.stringify({ type: "signal", signal: "SIGINT" }));
          await wait(() => visible(liveOutput.slice(since)).includes(`RW_PROMPT_${nonce}>`), "fresh PowerShell prompt after interrupt");
        },
        waitResize: expected => wait(() => size === expected, `ordered resize ${expected}`),
        waitOutput: marker => wait(() => visible(output).includes(marker), marker),
        tail: () => visible(output).slice(-1500),
      };
    }
    socket = await connect();
    socket.send({ type: "input", data: `$global:rwProbe='${nonce}'; function global:prompt { 'RW_'+'PROMPT_'+$global:rwProbe+'>' }; Write-Output ('READY_'+$rwProbe)\r` });
    await socket.waitOutput(`READY_${nonce}`);
    await socket.waitPrompt();
    socket.send({ type: "resize", cols: 112, rows: 35 });
    await socket.waitResize("112x35");
    socket.send({ type: "input", data: "Write-Output ('SIZE_'+$Host.UI.RawUI.WindowSize.Width+'x'+$Host.UI.RawUI.WindowSize.Height)\r" });
    await socket.waitOutput("SIZE_112x35");
    socket.send({ type: "input", data: "Write-Output ('WAIT_'+$rwProbe); Start-Sleep -Seconds 60\r" });
    await socket.waitOutput(`WAIT_${nonce}`);
    await socket.interrupt();
    socket.send({ type: "input", data: "Write-Output ('INTERRUPTED_'+$rwProbe)\r" });
    await socket.waitOutput(`INTERRUPTED_${nonce}`);
    socket.ws.close();
    socket = await connect();
    await socket.waitOutput(`READY_${nonce}`);
    socket.send({ type: "input", data: "Write-Output ('RECONNECTED_'+$rwProbe)\r" });
    await socket.waitOutput(`RECONNECTED_${nonce}`);
    const browserReports = [];
    async function verifyBrowserIdentity(phase, requireLaunchAddress = false) {
      await registerBrowserCandidate();
      const result = path.join(cwd, `browser-identity-${nonce}-${phase}.json`);
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const script = `$addressPresent=[bool]($env:RUNWEAVE_BASE_URL -or $env:RUNWEAVE_BACKEND_PORT)
${requireLaunchAddress ? "" : "Remove-Item Env:RUNWEAVE_BASE_URL,Env:RUNWEAVE_BACKEND_PORT -ErrorAction SilentlyContinue"}
$output=(& $env:RUNWEAVE_CLI_BIN browser doctor --wait-timeout-ms 0 --json 2>$null | Out-String)
$code=$LASTEXITCODE
$value=@{phase=${quote(phase)};exitCode=$code;addressPresent=$addressPresent;report=($output|ConvertFrom-Json)}|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText(${quote(result)},$value,[Text.UTF8Encoding]::new($false))
`;
      socket.send({ type: "input", data: `& powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}\r` });
      let observed;
      const until = Date.now() + 30_000;
      while (!observed) {
        try { observed = JSON.parse(readFileSync(result, "utf8")); } catch { /* Wait for this shell's result. */ }
        assert(Date.now() < until, `Browser identity probe timed out: ${phase}; ${socket.tail()}`);
        if (!observed) await sleep(100);
      }
      const report = observed.report;
      assert(observed.phase === phase && observed.exitCode === 3, `Browser probe did not report an unbound fixture: ${phase}`);
      assert(report.scope === "terminal-browser-control" && report.pageRequestsVerified === false, "Browser diagnostic coverage was overstated");
      assert(report.checks.find(check => check.stage === "identity")?.status === "passed", `Old terminal lost Browser identity: ${phase}`);
      assert(report.checks.find(check => check.stage === "binding")?.code === "BROWSER_BINDING_REQUIRED", `Browser identity failed before binding: ${phase}`);
      assert(!JSON.stringify(report).match(/cdpEndpoint|capability|gatewayToken|\/ticket\//), "Browser diagnostic leaked a credential");
      if (requireLaunchAddress) assert(observed.addressPresent, "Restored PTY was launched before Backend address initialization");
      browserReports.push({ phase, identity: "passed", binding: "unbound-fixture", launchAddressVerified: requireLaunchAddress });
    }
    // A private control peer is registered but never selected for this terminal.
    // BROWSER_BINDING_REQUIRED proves discovery + Hook auth, never browser UI readiness.
    await verifyBrowserIdentity("before-restart");
    let continuity;
    if (lifecycle) {
      const verified = await verifyWindowsHostedUpgrade({ ...lifecycle, id, socket, connect, home: cwd });
      continuity = verified.result; socket = verified.socket;
      await verifyBrowserIdentity(lifecycle.local ? "after-restart-and-upgrade" : "after-restart");
    }
    await api(`session/${id}`, undefined, "DELETE");
    const sessions = await api("session", undefined, "GET");
    assert(!sessions.some(item => item.terminalSessionId === id), "Closed terminal remains listed");
    id = null;
    if (lifecycle) {
      const before = JSON.parse(await lifecycle.rw("host", "status"));
      await lifecycle.rw("host", "update");
      const after = JSON.parse(await lifecycle.rw("host", "status"));
      assert(after.hostInstanceId !== before.hostInstanceId, "Host maintenance did not replace its identity");
      id = (await api("session", { projectId: project.projectId, command: "powershell.exe", args: [] })).terminalSessionId;
      socket = await connect();
      socket.send({ type: "input", data: "$r=$null; for($i=0;$i -lt 10;$i++){try{$r=Invoke-WebRequest -UseBasicParsing ($env:RUNWEAVE_APP_SERVER_URL+'/readyz') -Headers @{Authorization=('Bearer '+$env:RUNWEAVE_APP_SERVER_TOKEN)};break}catch{Start-Sleep -Seconds 1}}; Write-Output ('GATEWAY_'+[int]$r.StatusCode)\r" });
      await socket.waitOutput("GATEWAY_200");
      socket.ws.close();
      // All processes in this fixture are owned by this verification. Lose the
      // Host, then restart Backend to exercise actual startup-time PTY rebuilding.
      const releaseRelative = path.relative(path.join(cwd, ".runweave/server"), after.runningRelease);
      assert(releaseRelative && !releaseRelative.startsWith("..") && !path.isAbsolute(releaseRelative), "Refusing to stop a Host outside the fixture");
      process.kill(after.pid, "SIGKILL");
      await lifecycle.restartAfterCrash();
      socket = await connect();
      await verifyBrowserIdentity("restored-startup", lifecycle.local);
      await api(`session/${id}`, undefined, "DELETE"); id = null;
      continuity.hostMaintenance = true;
    }
    return { powershell: true, inputOutput: true, resize: true, ctrlC: true, reconnect: true, close: true, continuity,
      browserIdentity: browserReports, browserUiVerified: false };
  } finally {
    socket?.ws.close();
    if (id) await api(`session/${id}`, undefined, "DELETE").catch(() => {});
    if (browserBindingId) await fetch(`${url}/api/desktop-browser/bindings/${browserBindingId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    if (browserBridge) {
      browserBridge.closeAllConnections();
      await new Promise(resolve => browserBridge.close(resolve));
    }
    await api(`project/${project.projectId}`, undefined, "DELETE").catch(error => { console.error("Fixture project cleanup pending:", error.message); });
  }
}
