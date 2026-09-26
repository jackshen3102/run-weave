import path from "node:path";

import { assertLoopbackUrl } from "../contracts.mjs";
import { resolveBetaPaths } from "../../beta/state.mjs";

export function resolveBetaReconciliationPaths(services) {
  const beta = services.beta;
  const pooledBeta = /^pool-0[1-5]$/.test(beta?.instanceId ?? "");
  const desktopEndpoint = services.cdp?.desktop?.endpoint;
  const terminalBrowserEndpoint = services.cdp?.terminalBrowser?.endpoint;
  if (
    beta?.ownership !== "dedicated" ||
    beta.channel !== "beta" ||
    !beta.instanceId ||
    (pooledBeta &&
      (beta.slotId !== beta.instanceId ||
        typeof beta.leaseNonce !== "string" ||
        !beta.leaseNonce)) ||
    !beta.ownerDevSessionId ||
    !beta.userDataDir ||
    !beta.betaControl?.cwd ||
    !desktopEndpoint ||
    !terminalBrowserEndpoint
  ) {
    return null;
  }
  let desktopCdpPort;
  let terminalBrowserCdpPort;
  try {
    desktopCdpPort = Number(new URL(assertLoopbackUrl(desktopEndpoint)).port);
    terminalBrowserCdpPort = Number(
      new URL(assertLoopbackUrl(terminalBrowserEndpoint)).port,
    );
  } catch {
    return null;
  }
  const homeDir = path.resolve(beta.userDataDir, "../../../../..");
  const paths = resolveBetaPaths(
    beta.betaControl.cwd,
    homeDir,
    beta.instanceId,
    beta.ownerDevSessionId,
    { desktopCdpPort, terminalBrowserCdpPort },
  );
  if (
    paths.userData !== beta.userDataDir ||
    paths.desktopStatusPath !== beta.statusPath ||
    paths.appPath !== beta.appPath ||
    `http://127.0.0.1:${paths.desktopCdpPort}` !== desktopEndpoint ||
    `http://127.0.0.1:${paths.terminalBrowserCdpPort}` !==
      terminalBrowserEndpoint
  ) {
    return null;
  }
  return paths;
}

export function isCanonicalLoopbackEndpoint(endpoint) {
  try {
    const url = new URL(assertLoopbackUrl(endpoint));
    return (
      url.origin === endpoint &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number.isInteger(Number(url.port)) &&
      Number(url.port) > 0
    );
  } catch {
    return false;
  }
}
