const keys = [
  ["新窗口", "⇧⌘N"],
  ["关闭窗口", "⌘W"],
  ["系统监控", "⇧⌘M"],
  ["撤销", "⌘Z"],
  ["重做", "⇧⌘Z"],
  ["剪切", "⌘X"],
  ["复制", "⌘C"],
  ["粘贴", "⌘V"],
  ["全选", "⌘A"],
  ["重新加载页面", "⌘R"],
  ["强制重新加载", "⇧⌘R"],
  ["开发者工具", "⌥⌘I"],
  ["实际大小", "⌘0"],
  ["放大", "⌘+"],
  ["缩小", "⌘−"],
  ["全屏", "⌃⌘F"],
  ["最小化", "⌘M"],
  ["退出应用", "⌘Q"],
];
export default function Shortcuts() {
  return (
    <div className="space-y-3">
      <section className="divide-y rounded-md border">
        {keys.map(([name, key]) => (
          <div
            key={name}
            className="flex items-center justify-between gap-3 px-3 py-1 text-xs"
          >
            <span>{name}</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5">{key}</kbd>
          </div>
        ))}
      </section>
      <p className="text-sm text-muted-foreground">
        快捷键遵循桌面应用和系统菜单。File 菜单继续提供 Reload Local Runtime 与
        Export Desktop Diagnostics。
      </p>
    </div>
  );
}
