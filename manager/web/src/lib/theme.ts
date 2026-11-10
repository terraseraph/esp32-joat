import { createStore, useStore } from "../api/store";

export type ThemePref = "system" | "light" | "dark";
export const THEME_KEY = "deesp32-theme";
export const THEME_ORDER: ThemePref[] = ["system", "light", "dark"];
export const THEME_LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

function readStored(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const themeStore = createStore<ThemePref>(readStored());

const BG = { light: "#f2f4f8", dark: "#0f1419" };

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Set `data-theme` on <html> (removed for System) and keep the browser theme-color in step. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BG.dark : BG.light);
}

export function setThemePref(pref: ThemePref): void {
  themeStore.set(pref);
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the choice still applies for this session */
  }
  applyTheme(pref);
}

/** Call once at startup: applies the stored theme and follows OS changes while on System. */
export function initTheme(): void {
  applyTheme(themeStore.get());
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themeStore.get()));
  } catch {
    /* no matchMedia */
  }
}

export function useThemePref(): ThemePref {
  return useStore(themeStore);
}
