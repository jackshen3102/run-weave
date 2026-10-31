import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJson,
  stopOwned,
  waitHealthy,
  writeJson,
  type Component,
  type ServerContext,
} from "./context.js";

interface ServiceRegistration {
  platform: string;
  user: string;
  node: string;
  files: string[];
}
const label = (name: Component) => `com.runweave.server.${name}`;
const unit = (name: Component) => `runweave-server-${name}.service`;
const names: Component[] = ["app-server", "backend"];
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const quote = (s: string) =>
  '"' +
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n") +
  '"';

export function registered(ctx: ServerContext): boolean {
  return existsSync(path.join(ctx.home, "service.json"));
}
function capture(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
export function serviceStatus(ctx: ServerContext) {
  if (!registered(ctx)) return { installed: false, enabled: false };
  const registration = readJson<ServiceRegistration>(
    path.join(ctx.home, "service.json"),
  );
  const enabled =
    process.platform === "linux"
      ? names.every(
          (name) =>
            capture("systemctl", ["is-enabled", unit(name)]) === "enabled",
        )
      : names.every((name) =>
          existsSync(`/Library/LaunchDaemons/${label(name)}.plist`),
        );
  return {
    installed: true,
    enabled,
    platform: registration.platform,
    user: registration.user,
  };
}
async function system(command: string, args: string[]): Promise<void> {
  const elevated = process.getuid?.() !== 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      elevated ? "sudo" : command,
      elevated ? [command, ...args] : args,
      { stdio: ["inherit", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} failed (${code}); check service manager permissions and logs`,
            ),
          ),
    );
  });
}

export function renderService(ctx: ServerContext, name: Component): string {
  const args = [
    process.execPath,
    path.join(ctx.home, "current/server/index.cjs"),
    "component",
    name,
    ...ctx.configArgs,
  ];
  const info = os.userInfo();
  const log = path.join(ctx.home, `${name}.log`);
  if (process.platform === "linux")
    return [
      "[Unit]",
      `Description=Runweave ${name}`,
      ...(name === "backend"
        ? [
            "After=runweave-server-app-server.service",
            "Wants=runweave-server-app-server.service",
          ]
        : []),
      "StartLimitIntervalSec=120",
      "StartLimitBurst=5",
      "[Service]",
      "Type=simple",
      `User=${info.username}`,
      `WorkingDirectory=${quote(info.homedir)}`,
      `Environment=${quote(`HOME=${info.homedir}`)}`,
      `Environment=${quote(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)}`,
      `ExecStart=${args.map(quote).join(" ")}`,
      "Restart=on-failure",
      "RestartSec=10",
      "TimeoutStopSec=90",
      ...(name === "backend" ? ["KillMode=process"] : []),
      `StandardOutput=${quote(`append:${log}`)}`,
      `StandardError=${quote(`append:${log}`)}`,
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label(name)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>UserName</key><string>${xml(info.username)}</string>
<key>WorkingDirectory</key><string>${xml(info.homedir)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(info.homedir)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>90</integer>
${name === "backend" ? "<key>AbandonProcessGroup</key><true/>" : ""}
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}

export async function serviceInstall(ctx: ServerContext): Promise<void> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unsupported service manager");
  const directory = path.join(ctx.home, "units");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  const candidates: { file: string; target: string; existed: boolean }[] = [];
  for (const name of names) {
    const file = path.join(
      directory,
      process.platform === "linux" ? unit(name) : `${label(name)}.plist`,
    );
    writeFileSync(file, renderService(ctx, name), { mode: 0o600 });
    if (process.platform === "linux")
      execFileSync("systemd-analyze", ["verify", file], { stdio: "pipe" });
    else execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
    const target =
      process.platform === "linux"
        ? `/etc/systemd/system/${unit(name)}`
        : `/Library/LaunchDaemons/${label(name)}.plist`;
    if (
      existsSync(target) &&
      readFileSync(target, "utf8") !== renderService(ctx, name)
    )
      throw new Error(
        `Existing service differs: ${target}; refuse to overwrite another installation`,
      );
    candidates.push({ file, target, existed: existsSync(target) });
    files.push(target);
  }
  const created: string[] = [];
  try {
    for (const candidate of candidates) {
      await system("install", [
        "-m",
        "644",
        "-o",
        "root",
        candidate.file,
        candidate.target,
      ]);
      if (!candidate.existed) created.push(candidate.target);
    }
  } catch (error) {
    for (const target of created.reverse()) await system("rm", [target]);
    throw error;
  }
  writeJson(path.join(ctx.home, "service.json"), {
    platform: process.platform,
    user: os.userInfo().username,
    node: process.execPath,
    files,
  });
  if (process.platform === "linux") {
    await system("systemctl", ["daemon-reload"]);
    await system("systemctl", ["enable", ...names.map(unit)]);
  }
  if (process.platform === "darwin")
    for (const name of names)
      await system("launchctl", ["enable", `system/${label(name)}`]);
  await serviceStart(ctx);
  if (!serviceStatus(ctx).enabled)
    throw new Error("Service manager did not enable boot startup");
}
export async function serviceStart(ctx: ServerContext): Promise<void> {
  for (const name of names) {
    if (process.platform === "linux")
      await system("systemctl", ["start", unit(name)]);
    else if (capture("launchctl", ["print", `system/${label(name)}`]) === null)
      await system("launchctl", [
        "bootstrap",
        "system",
        `/Library/LaunchDaemons/${label(name)}.plist`,
      ]);
    await waitHealthy(ctx, name);
  }
}
export async function serviceStop(ctx: ServerContext): Promise<void> {
  if (!registered(ctx)) throw new Error("Service is not registered");
  for (const name of [...names].reverse()) {
    if (process.platform === "linux")
      await system("systemctl", ["stop", unit(name)]);
    else if (capture("launchctl", ["print", `system/${label(name)}`]) !== null)
      await system("launchctl", ["bootout", `system/${label(name)}`]);
    await stopOwned(ctx, name);
  }
}
export async function serviceUninstall(ctx: ServerContext): Promise<void> {
  if (!registered(ctx)) return;
  const registration = readJson<ServiceRegistration>(
    path.join(ctx.home, "service.json"),
  );
  await serviceStop(ctx);
  if (process.platform === "linux")
    await system("systemctl", ["disable", ...names.map(unit)]);
  for (const file of registration.files) {
    const allowed = names.some(
      (name) =>
        file ===
        (process.platform === "linux"
          ? `/etc/systemd/system/${unit(name)}`
          : `/Library/LaunchDaemons/${label(name)}.plist`),
    );
    if (!allowed) throw new Error("Unexpected registered service path");
    if (existsSync(file) && !readFileSync(file, "utf8").includes(ctx.home))
      throw new Error("Service ownership changed; refusing removal");
    await system("rm", [file]);
  }
  if (process.platform === "linux")
    await system("systemctl", ["daemon-reload"]);
  rmSync(path.join(ctx.home, "service.json"));
}
