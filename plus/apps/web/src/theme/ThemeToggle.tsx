import { useTheme } from "./ThemeProvider.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "paper" ? "graphite" : "paper";
  return (
    <button
      type="button"
      className="console-account-link"
      onClick={() => setTheme(next)}
      aria-label={`切换到${next === "paper" ? "浅色" : "深色"}主题`}
    >
      {theme === "paper" ? "深色" : "浅色"}
    </button>
  );
}
