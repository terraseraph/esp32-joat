import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { THEME_LABEL, THEME_ORDER, setThemePref, useThemePref, type ThemePref } from "../../lib/theme";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";

const ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** Cycles System, Light, Dark. */
export function ThemeToggle({ labelVisible, tooltipSide }: { labelVisible: boolean; tooltipSide: "right" | "bottom" }) {
  const pref = useThemePref();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length] ?? "system";
  const Icon = ICON[pref];
  return (
    <Tooltip label={`Theme: ${THEME_LABEL[pref]}`} side={tooltipSide} disabled={labelVisible}>
      <Button
        variant="ghost"
        data-theme-toggle
        aria-label={`Theme: ${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[next]}.`}
        onClick={() => setThemePref(next)}
      >
        <Icon className="i" aria-hidden="true" />
        <span className="lbl">Theme: {THEME_LABEL[pref]}</span>
      </Button>
    </Tooltip>
  );
}
