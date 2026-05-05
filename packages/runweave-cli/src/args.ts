import { CliError } from "./errors.js";
import type { OutputMode } from "./output/format.js";

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(args: string[], booleanOptions = new Set<string>()): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      if (arg != null) {
        positionals.push(arg);
      }
      continue;
    }

    const equalIndex = arg.indexOf("=");
    const name = arg.slice(2, equalIndex > 0 ? equalIndex : undefined);
    if (!name) {
      throw new CliError(`Invalid option: ${arg}`, 2);
    }

    if (booleanOptions.has(name)) {
      options[name] = equalIndex > 0 ? arg.slice(equalIndex + 1) !== "false" : true;
      continue;
    }

    const value = equalIndex > 0 ? arg.slice(equalIndex + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError(`Missing value for --${name}`, 2);
    }
    options[name] = value;
    if (equalIndex < 0) {
      index += 1;
    }
  }

  return { positionals, options };
}

export function getStringOption(
  options: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function requireStringOption(
  options: Record<string, string | boolean>,
  name: string,
): string {
  const value = getStringOption(options, name);
  if (!value) {
    throw new CliError(`Missing required option --${name}`, 2);
  }
  return value;
}

export function getBooleanOption(
  options: Record<string, string | boolean>,
  name: string,
): boolean {
  return options[name] === true;
}

export function resolveOutputMode(options: Record<string, string | boolean>): OutputMode {
  return options.json === true ? "json" : "plain";
}
