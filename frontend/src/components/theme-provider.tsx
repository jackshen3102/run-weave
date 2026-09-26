import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";

export function ThemeProvider(props: ThemeProviderProps) {
  // next-themes owns its DOM bootstrap and storage listener; retain its registered key.
  return <NextThemesProvider {...props} storageKey="theme" />;
}
