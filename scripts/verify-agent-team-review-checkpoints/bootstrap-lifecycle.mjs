import { verifyBootstrapAuthority } from "./bootstrap-lifecycle-authority.mjs";
import { verifyBootstrapCore } from "./bootstrap-lifecycle-core.mjs";
import { verifyBootstrapFailures } from "./bootstrap-lifecycle-failures.mjs";

export async function verifyBootstrapLifecycle(check, roots) {
  await verifyBootstrapAuthority(check, roots);
  await verifyBootstrapCore(check, roots);
  await verifyBootstrapFailures(check, roots);
}
