import { jsx as _jsx } from "react/jsx-runtime";
import { ThemeProvider as NextThemesProvider } from "next-themes";
export function ThemeProvider(props) {
    return _jsx(NextThemesProvider, { ...props });
}
