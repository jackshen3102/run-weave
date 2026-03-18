import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <Button variant="secondary" size="sm">Theme</Button>;
  }

  const isDark = theme === "dark";
  return (
    <Button onClick={() => setTheme(isDark ? "light" : "dark")} variant="secondary" size="sm">
      {isDark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
      {isDark ? "Light" : "Dark"}
    </Button>
  );
}
