import type { ImportWorkFacts } from "@runweave/shared/suiji";
import { invalid } from "../errors";
export const blockedScope = (scope: string) =>
  /^(browser|materials|browse):/.test(scope);
/** Check before idempotency replay as well: old mixed responses must not enter a new work context. */
export function assertWorkImport(input: ImportWorkFacts) {
  if (
    input.materialResults?.length ||
    input.days?.some(
      (d) =>
        d.requestedScopes.some(blockedScope) ||
        d.receipts.some((r) => blockedScope(r.sourceScope)) ||
        d.facts.some((f) =>
          f.sourceRefs.some(
            (r) =>
              ["browser-visit", "suiji-material"].includes(r.channel) ||
              blockedScope(r.sourceScope),
          ),
        ),
    )
  )
    throw invalid("浏览与素材已移出工作；旧批次只能核对原回执，不能重新导入");
}
