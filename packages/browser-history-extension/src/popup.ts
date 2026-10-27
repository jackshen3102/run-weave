async function refresh(op = "status", enabled?: boolean) {
  try {
    const state = await chrome.runtime.sendMessage({ op, enabled });
    const checkbox = document.getElementById("recording") as HTMLInputElement;
    checkbox.checked = state.enabled === true;
    document.getElementById("status")!.textContent =
      state.error ??
      (state.pending
        ? "正在等待本机保存"
        : state.lastStoredAt
          ? `已落盘 · ${state.lastStoredAt}`
          : "等待首条记录写入");
    document.getElementById("count")!.textContent = String(state.today ?? 0);
    document.getElementById("pending")!.textContent = String(
      state.pending ?? 0,
    );
  } catch (error) {
    document.getElementById("status")!.textContent =
      `无法读取扩展状态：${String(error)}`;
  }
}
document.getElementById("recording")!.addEventListener("change", (e) => {
  void refresh("toggle", (e.target as HTMLInputElement).checked);
});
document.getElementById("retry")!.addEventListener("click", () => {
  void refresh("flush");
});
void refresh();
setInterval(() => {
  void refresh();
}, 2000);
