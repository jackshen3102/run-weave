import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
        return _jsx(Button, { variant: "secondary", size: "sm", children: "Theme" });
    }
    const isDark = theme === "dark";
    return (_jsxs(Button, { onClick: () => setTheme(isDark ? "light" : "dark"), variant: "secondary", size: "sm", children: [isDark ? _jsx(Sun, { className: "mr-2 h-4 w-4" }) : _jsx(Moon, { className: "mr-2 h-4 w-4" }), isDark ? "Light" : "Dark"] }));
}
