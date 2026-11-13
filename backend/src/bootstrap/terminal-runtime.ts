import { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import type { ResourceScope } from "./resource-scope";

/** Keep registry teardown in the existing terminal-resource order. */
export function registerTerminalRuntimeRegistry(resources: ResourceScope, registry: TerminalRuntimeRegistry): void {
  resources.defer("terminal-runtimes", () => registry.disposeAll());
}
