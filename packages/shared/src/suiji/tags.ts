import { SUIJI_LIMITS } from "./limits";

export function normalizeSuijiTags(values: string[]): string[] {
  if (values.length > SUIJI_LIMITS.tagsPerRecord)
    throw new Error("最多 2 个标签");
  const tags = values.map((value) => value.trim());
  if (
    tags.some(
      (tag) =>
        !tag ||
        [...tag].length > SUIJI_LIMITS.tagScalars ||
        // Reject control characters and lone surrogates in user-provided names.
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(tag),
    )
  )
    throw new Error("标签须为 1–20 个字符，不能包含控制字符或无效 Unicode");
  if (new Set(tags).size !== tags.length) throw new Error("标签不能重复");
  return tags;
}
