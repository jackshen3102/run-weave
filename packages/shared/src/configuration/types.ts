export type ConfigurationValue = null | boolean | number | string | ConfigurationValue[] | ConfigurationObject;
export interface ConfigurationObject { [key: string]: ConfigurationValue }
export interface EnvironmentIdentity { kind: "stable" | "dev"; instanceId: string }
export interface EnvironmentContext extends EnvironmentIdentity { configRoot: string }
export interface ConfigurationFile extends ConfigurationObject {
  schemaVersion: 1;
  revision: number;
  kind: "stable" | "dev";
  instanceId: string;
  domainVersions: Record<string, number>;
  migrations: ConfigurationObject;
}
export interface ConfigurationIssue { path: string; code: string }
export interface ConfigurationLocation { line: number; column: number }
export interface ConfigurationField {
  owner: string;
  scope: "instance";
  storage: "settings.yaml";
  default: { value: ConfigurationValue } | { rule: string };
  migrationSources: readonly string[];
  path: string;
  type: "string" | "boolean" | "number" | "integer" | "array<string>" | "array<number>";
  domain: string;
  sensitive: boolean;
  remote: boolean;
  apply: "reload" | "restart";
  description: string;
  environmentKeys: readonly string[];
}
export interface ConfigurationPatch {
  expectedRevision: number;
  expectedDigest: string;
  changes: Record<string, ConfigurationValue>;
}
export interface ConfigurationConsumerState {
  appliedRevision: number | null;
  state: "applied" | "restartRequired" | "error" | "unconfigured";
  issues: ConfigurationIssue[];
}
export interface ConfigurationStatus {
  environment: EnvironmentIdentity;
  savedRevision: number | null;
  digest: string | null;
  diskError?: { code: string; location?: ConfigurationLocation };
  values: ConfigurationObject;
  consumers: Record<string, ConfigurationConsumerState>;
}

export type PublicConfigurationField = Pick<ConfigurationField, "path" | "type" | "domain" | "sensitive" | "apply" | "description" | "default">;
export interface PublicConfigurationStatus extends ConfigurationStatus {
  fields: PublicConfigurationField[];
}
export interface PublicConfigurationPatch extends ConfigurationPatch {
  expectedEnvironment: EnvironmentIdentity;
}
