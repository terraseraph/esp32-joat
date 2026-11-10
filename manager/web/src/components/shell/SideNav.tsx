import { Archive, Cpu, Download, LayoutGrid, Radar, Settings, type LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import { cx } from "../../lib/cx";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { Tooltip } from "../ui/Tooltip";
import { ServerIndicator } from "./ServerIndicator";
import { ThemeToggle } from "./ThemeToggle";

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that also mark this entry active (device pages belong to Fleet). */
  alsoActiveFor?: string[];
}

export const NAV: NavEntry[] = [
  { to: "/", label: "Fleet", icon: LayoutGrid, alsoActiveFor: ["/devices"] },
  { to: "/discover", label: "Discover", icon: Radar },
  { to: "/firmware", label: "Firmware", icon: Download },
  { to: "/backups", label: "Backups", icon: Archive },
  { to: "/settings", label: "Settings", icon: Settings },
];

function isActive(entry: NavEntry, pathname: string): boolean {
  if (entry.to === "/") return pathname === "/" || (entry.alsoActiveFor ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return pathname === entry.to || pathname.startsWith(`${entry.to}/`);
}

export function SideNav() {
  const { pathname } = useLocation();
  const rail = useMediaQuery("(max-width: 1023.98px)");
  const topBar = useMediaQuery("(max-width: 767.98px)");
  const side = topBar ? "bottom" : "right";
  return (
    <aside className="nav">
      <Link className="brand" to="/" aria-label="de-esp32 Manager">
        <span className="logo">
          <Cpu className="i" aria-hidden="true" />
        </span>
        <span className="lbl">de-esp32 Manager</span>
      </Link>
      <nav className="nav-list" aria-label="Main">
        {NAV.map((entry) => {
          const active = isActive(entry, pathname);
          const Icon = entry.icon;
          return (
            <Tooltip key={entry.to} label={entry.label} side={side} disabled={!rail}>
              <Link
                to={entry.to}
                className={cx("nav-item", active && "on")}
                aria-label={entry.label}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="i" aria-hidden="true" />
                <span className="lbl">{entry.label}</span>
              </Link>
            </Tooltip>
          );
        })}
      </nav>
      <div className="nav-foot">
        <ServerIndicator tooltipSide={side} />
        <ThemeToggle labelVisible={!rail} tooltipSide={side} />
      </div>
    </aside>
  );
}
