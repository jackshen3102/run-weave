import { verifyWindowsHostedUpgrade } from "./windows-host-upgrade.mjs";
// Real authenticated HTTP + WebSocket + ConPTY integration, against an installed Server.
import { randomBytes } from "node:crypto";
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
  let socket, id;
  try {
    const created = await api("session", { projectId: project.projectId });
    id = created.terminalSessionId;
    const session = await api(`session/${id}`, undefined, "GET");
    assert(session.command.toLowerCase().endsWith("powershell.exe"), "Default shell is not PowerShell");
    assert(!session.tmuxSessionName, "Windows unexpectedly created tmux");
    async function connect() {
      const { ticket } = await api(`session/${id}/ws-ticket`, {});
      const ws = new WebSocket(`${url.replace("http", "ws")}/ws/terminal?terminalSessionId=${id}&token=${encodeURIComponent(ticket)}&resizeMode=ordered`);
      let output = "", connected = false, failure, size;
      ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (["output", "snapshot"].includes(message.type)) output += message.data;
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
      return {
        ws,
        send: message => ws.send(JSON.stringify(message)),
        waitResize: expected => wait(() => size === expected, `ordered resize ${expected}`),
        // eslint-disable-next-line no-control-regex -- Strip terminal ANSI controls before checking visible output.
        waitOutput: marker => wait(() => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").includes(marker), marker),
      };
    }
    const nonce = randomBytes(6).toString("hex");
    socket = await connect();
    socket.send({ type: "input", data: `$rwProbe='${nonce}'; Write-Output ('READY_'+$rwProbe)\r` });
    await socket.waitOutput(`READY_${nonce}`);
    socket.send({ type: "resize", cols: 112, rows: 35 });
    await socket.waitResize("112x35");
    socket.send({ type: "input", data: "Write-Output ('SIZE_'+$Host.UI.RawUI.WindowSize.Width+'x'+$Host.UI.RawUI.WindowSize.Height)\r" });
    await socket.waitOutput("SIZE_112x35");
    socket.send({ type: "input", data: "Write-Output ('WAIT_'+$rwProbe); Start-Sleep -Seconds 60\r" });
    await socket.waitOutput(`WAIT_${nonce}`);
    socket.send({ type: "signal", signal: "SIGINT" });
    await sleep(300);
    socket.send({ type: "input", data: "Write-Output ('INTERRUPTED_'+$rwProbe)\r" });
    await socket.waitOutput(`INTERRUPTED_${nonce}`);
    socket.ws.close();
    socket = await connect();
    await socket.waitOutput(`READY_${nonce}`);
    socket.send({ type: "input", data: "Write-Output ('RECONNECTED_'+$rwProbe)\r" });
    await socket.waitOutput(`RECONNECTED_${nonce}`);
    let continuity;
    if (lifecycle) {
      const verified = await verifyWindowsHostedUpgrade({ ...lifecycle, id, socket, connect, home: cwd });
      continuity = verified.result; socket = verified.socket;
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
      id = (await api("session", { projectId: project.projectId })).terminalSessionId;
      socket = await connect();
      socket.send({ type: "input", data: "$r=$null; for($i=0;$i -lt 10;$i++){try{$r=Invoke-WebRequest -UseBasicParsing ($env:RUNWEAVE_APP_SERVER_URL+'/readyz') -Headers @{Authorization=('Bearer '+$env:RUNWEAVE_APP_SERVER_TOKEN)};break}catch{Start-Sleep -Seconds 1}}; Write-Output ('GATEWAY_'+[int]$r.StatusCode)\r" });
      await socket.waitOutput("GATEWAY_200");
      await api(`session/${id}`, undefined, "DELETE"); id = null;
      continuity.hostMaintenance = true;
    }
    return { powershell: true, inputOutput: true, resize: true, ctrlC: true, reconnect: true, close: true, continuity };
  } finally {
    socket?.ws.close();
    if (id) await api(`session/${id}`, undefined, "DELETE").catch(() => {});
    await api(`project/${project.projectId}`, undefined, "DELETE").catch(error => { console.error("Fixture project cleanup pending:", error.message); });
  }
}
