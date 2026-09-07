import { useTheme } from "next-themes";

export function SuijiThemeSelect() {
  const { theme, setTheme } = useTheme();
  return (
    <select
      aria-label="外观主题"
      value={theme ?? "system"}
      onChange={(event) => setTheme(event.target.value)}
      className="h-9 rounded-xl border bg-card px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  );
}
