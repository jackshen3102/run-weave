import { acquireConfigurationOwner, configuration as runtimeConfiguration, settingText, startLocalServiceProcessReporter } from "@runweave/config-node";
import { configuration } from "./config";
import { GatewayStore } from "./store";
import { createGateway } from "./app";
import { createAPNsTransport } from "./apns";
const config = configuration();
const owner = acquireConfigurationOwner(runtimeConfiguration().context, "push-gateway");
const store = new GatewayStore(config.directory);
const server = createGateway(
  store,
  createAPNsTransport(config),
  settingText("services.pushGateway.adminToken"),
);
server.listen(config.port, config.bind, () =>
  process.stdout.write("Push gateway ready\n"),
);
let stopping = false;
const stopReporting = startLocalServiceProcessReporter("push-gateway", "推送网关", () => {
  let ready = false;
  try { store.snapshot(); ready = server.listening && !stopping; } catch { /* Owner reports storage failure without leaking credentials. */ }
  return { ready, port: config.port, summary: ready ? "HTTP 监听与本地存储可用；APNs 投递及手机收取需单独验证" : "监听或本地存储不可用" };
});
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await stopReporting();
    await server.disposeBadges();
    store.close();
    owner.release();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
