import type { SuijiIdentity } from "./auth";

export function suijiHandoff(
  target: SuijiIdentity & { endpoint: string; recordId: string },
) {
  return (
    "使用随记 Skill 处理这条记录。先读取最新原文、全部跟进和相关附件，按我本次要求执行；成功后只追加最终成果，不记录过程或失败。未经我确认，不标记完成。\n" +
    JSON.stringify({ format: "suiji-handoff-v1", ...target }, null, 2)
  );
}
