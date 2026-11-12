import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type ThemeName = "paper" | "graphite" | "afterglow";

const STORAGE_KEY = "artflow-theme";
const VALID_THEMES: readonly ThemeName[] = ["paper", "graphite", "afterglow"];

interface ThemeContextValue {
  readonly theme: ThemeName;
  readonly setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "graphite",
  setTheme: () => undefined,
});

function readStoredTheme(fallback: ThemeName): ThemeName {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "paper" || stored === "graphite" || stored === "afterglow" ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function ThemeProvider({ children, defaultTheme = "graphite" }: {
  readonly children: ReactNode;
  readonly defaultTheme?: ThemeName;
}) {
  const [theme, setThemeState] = useState<ThemeName>(() => readStoredTheme(defaultTheme));
  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme: (next) => {
      if (!VALID_THEMES.includes(next)) return;
      setThemeState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage is optional; the in-memory theme still applies.
      }
    },
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
