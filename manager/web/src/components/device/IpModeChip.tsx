import { Chip } from "../ui/Chip";

/** "DHCP" (muted) or "Static" (accent). Renders nothing when the device does not report a mode, or it is unknown. */
export function IpModeChip({ mode, className }: { mode: string | null | undefined; className?: string }) {
  if (mode === "dhcp")
    return (
      <Chip className={className} title="The address comes from your router (DHCP)">
        DHCP
      </Chip>
    );
  if (mode === "static")
    return (
      <Chip tone="acc" className={className} title="The device uses a fixed address">
        Static
      </Chip>
    );
  return null;
}
