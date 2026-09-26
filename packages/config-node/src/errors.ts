import type { ConfigurationLocation } from "@runweave/shared/configuration";

export class ConfigurationError extends Error {
  constructor(readonly code: string, readonly fields: readonly string[] = [], readonly location?: ConfigurationLocation) {
    super(`${code}${fields.length ? `: ${fields.join(", ")}` : ""}${location ? ` (line ${location.line}, column ${location.column})` : ""}`);
    this.name = "ConfigurationError";
  }
}
