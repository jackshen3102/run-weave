import type { ConfigurationObject, ConfigurationValue } from "./types";
export * from "./types";
export * from "./compatibility";
export { CONFIGURATION_FIELDS } from "./fields";

export function isConfigurationObject(value: unknown): value is ConfigurationObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readConfigurationPath(value: ConfigurationObject, key: string): ConfigurationValue | undefined {
  let current: ConfigurationValue | undefined = value;
  for (const segment of configurationPathSegments(key)) {
    if ((!isConfigurationObject(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as ConfigurationObject)[segment];
  }
  return current;
}

export function configurationPathSegments(key: string): string[] {
  const segments: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of key) {
    if (escaped) { current += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (char === ".") { segments.push(current); current = ""; }
    else current += char;
  }
  if (escaped) current += "\\";
  segments.push(current);
  return segments;
}
export function configurationPathSegment(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
}
