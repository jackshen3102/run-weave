import { verifyBootstrapAuthority } from "./authority.mjs";
import { verifyBootstrapCore } from "./core.mjs";
import { verifyBootstrapFailures } from "./failures.mjs";

export async function verifyBootstrapLifecycle(check, roots) {
  await verifyBootstrapAuthority(check, roots);
  await verifyBootstrapCore(check, roots);
  await verifyBootstrapFailures(check, roots);
}
