import type { SuijiIdentity } from "./auth";

export function suijiHandoff(
  target: SuijiIdentity & { endpoint: string; recordId: string },
) {
  return (
    "使用随记 Skill 处理这条记录。先读取最新原文、全部跟进和相关附件，按我本次要求执行。完整结果、图片和文档在当前终端交付；随记只追加简短最终摘要，默认不上传图片、文档或附件，不记录过程或失败。后续问答、补图不自动回写。未经我确认，不标记完成。\n" +
    JSON.stringify({ format: "suiji-handoff-v1", ...target }, null, 2)
  );
}
