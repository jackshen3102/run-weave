import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { createAuthClient } from "../client/auth-client.js";
import { resolveAuthContext } from "../client/auth-context.js";
import {
  ProfileStore,
  resolveRunweaveBaseUrl,
} from "../config/profile-store.js";
import { CliError, toCliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runAuthCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (subcommand === "login") {
    await login(args, io);
    return;
  }
  if (subcommand === "status") {
    await status(args, io);
    return;
  }
  throw new CliError("Usage: rw auth <login|status>", 2);
}

async function login(
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const profileName = getStringOption(parsed.options, "profile") ?? "local";
  const baseUrl = resolveRunweaveBaseUrl({
    env: io.env,
    explicitBaseUrl: getStringOption(parsed.options, "base-url"),
    explicitBackendPort: getStringOption(parsed.options, "backend-port"),
  });
  const username = getStringOption(parsed.options, "username") ?? "admin";
  const password =
    getStringOption(parsed.options, "password") ??
    (await readPassword(io.stdin, io.stdout));
  const profile = await createAuthClient().login({
    baseUrl,
    username,
    password,
  });
  await new ProfileStore().saveProfile(profileName, profile);
  writeOutput(io.stdout, mode, {
    profile: profileName,
    baseUrl: profile.baseUrl,
    authenticated: true,
    expiresAt: profile.expiresAt,
  });
}

async function status(
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const profileName = getStringOption(parsed.options, "profile");
  const store = new ProfileStore();

  try {
    const auth = await resolveAuthContext({
      profileName,
      backendPort: getStringOption(parsed.options, "backend-port"),
      store,
      env: io.env,
    });
    await auth.requestJson<{ valid: boolean }>("/api/auth/verify");
    const savedConfig = await store.load();
    const savedProfile = savedConfig?.profiles[auth.profileName];
    writeOutput(io.stdout, mode, {
      profile: auth.profileName,
      baseUrl: auth.baseUrl,
      authenticated: true,
      expiresAt: savedProfile?.expiresAt ?? null,
      source: io.env.RUNWEAVE_ACCESS_TOKEN?.trim() ? "env" : "profile",
    });
  } catch (error) {
    const cliError = toCliError(error);
    if (cliError.exitCode !== 3) {
      throw cliError;
    }
    writeOutput(io.stdout, mode, {
      profile: profileName ?? "local",
      authenticated: false,
    });
  }
}

async function readPassword(
  stdin: NodeJS.ReadStream,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const password = Buffer.concat(chunks).toString("utf8").trim();
    if (password) {
      return password;
    }
  }

  const rawStdin = stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  if (!rawStdin.setRawMode) {
    throw new CliError("Secure password input is unavailable", 2);
  }

  const password = await new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(rawStdin.isRaw);
    const cleanup = () => {
      rawStdin.off("data", onData);
      rawStdin.setRawMode?.(wasRaw);
    };
    const finish = () => {
      cleanup();
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const input = chunk.toString("utf8");
      if (input === "\u0003") {
        cleanup();
        stdout.write("\n");
        reject(new CliError("Password input cancelled", 130));
        return;
      }
      if (input === "\r" || input === "\n" || input === "\r\n") {
        finish();
        return;
      }
      if (input === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += input;
    };

    stdout.write("Password: ");
    rawStdin.setRawMode(true);
    rawStdin.resume();
    rawStdin.on("data", onData);
  });
  if (!password) {
    throw new CliError("Password is required", 2);
  }
  return password;
}

export const defaultAuthIo = {
  stdin: defaultStdin,
  stdout: defaultStdout,
  env: process.env,
};
