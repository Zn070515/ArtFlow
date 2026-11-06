import * as THREE from "three";

/**
 * Reads the active Portal theme tokens so the three.js hero follows the same
 * palette as the CSS shell. Falls back to the original gold palette when the
 * shell is not mounted (unit tests) or a token is missing.
 */
export function themeColor(variable: string, fallback: string): THREE.Color {
  if (typeof document === "undefined") return new THREE.Color(fallback);
  const host =
    document.querySelector('[data-shell="portal"]') ?? document.documentElement;
  const value = getComputedStyle(host).getPropertyValue(variable).trim();
  return new THREE.Color(value === "" ? fallback : value);
}
