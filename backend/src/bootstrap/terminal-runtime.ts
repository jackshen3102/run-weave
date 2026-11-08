import { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import { reconcileHostedTerminals } from "../terminal/runtime/pty-host-runtime";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { ResourceScope } from "./resource-scope";

/** Keep registry teardown in the existing terminal-resource order. */
export function registerTerminalRuntimeRegistry(resources: ResourceScope, registry: TerminalRuntimeRegistry): void {
  resources.defer("terminal-runtimes", () => registry.disposeAll());
}
export async function initializeTerminalManagerRuntimes(manager: TerminalSessionManager, registry: TerminalRuntimeRegistry): Promise<void> {
  await manager.initialize();
  await reconcileHostedTerminals(manager, registry);
}
