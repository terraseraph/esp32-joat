import { NavLink } from "react-router";

export const DEVICE_TABS = [
  { slug: "live", label: "Live" },
  { slug: "pins", label: "Pins & add-ons" },
  { slug: "network", label: "Network" },
  { slug: "system", label: "System" },
] as const;

export type DeviceTabSlug = (typeof DEVICE_TABS)[number]["slug"];

export function isDeviceTab(s: string | undefined): s is DeviceTabSlug {
  return DEVICE_TABS.some((t) => t.slug === s);
}

/** Route-based tabs (`/devices/:id/live|pins|network|system`); the active one gets `aria-current="page"`. */
export function DeviceTabs({ id }: { id: string }) {
  return (
    <nav className="tabs" aria-label="Device sections">
      {DEVICE_TABS.map((t) => (
        <NavLink key={t.slug} to={`/devices/${encodeURIComponent(id)}/${t.slug}`} className={({ isActive }) => (isActive ? "on" : undefined)}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
