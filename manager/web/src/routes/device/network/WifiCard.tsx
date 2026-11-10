import type { NetworkStatus } from "@shared/device-api";
import { Banner, Card, CardHead, Chip, KeyValue, type KeyValueItem } from "../../../components/ui";
import { formatRssi } from "../../../lib/format";
import { netStateWords, wifiChangeSentence } from "./logic";
import { WifiMoveSection } from "./wifimove/WifiMoveSection";

/** Wi-Fi card: the status and, on firmware that reports `wifi_change`, "Move to another Wi-Fi network" (L1). */
export function WifiCard({ id, net, down, deviceName, onChanged }: { id: string; net: NetworkStatus; down: boolean; deviceName: string; onChanged?: () => void }) {
  const words = netStateWords(net.state);
  const connected = net.sta_connected || net.state === "sta_connected" || net.state === "apsta_recovery";
  const rssi = net.rssi !== 0 && connected ? formatRssi(net.rssi) : null;
  const change = wifiChangeSentence(net.wifi_change);
  const items: KeyValueItem[] = [
    { label: "Status", value: words.label },
    { label: "IP address", value: net.sta_ip, mono: true },
    { label: "Hostname", value: net.hostname ? `${net.hostname}.local` : "", mono: true },
    {
      label: "Signal",
      value: rssi ? (
        <>
          <span className="nt-sig" data-l={rssi.bars} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {rssi.label} <span className="mut">(measured when it connected)</span>
        </>
      ) : null,
    },
    { label: "Provisioned", value: net.provisioned ? "Yes" : "No" },
  ];
  return (
    <Card className={down ? "nt-card is-down" : "nt-card"} aria-labelledby="nt-wifi-h">
      <CardHead title={<span id="nt-wifi-h">Wi-Fi</span>} actions={<Chip tone={down ? "off" : words.tone}>{words.label}</Chip>} />
      {net.state === "apsta_recovery" && (
        <Banner tone="warn" title="The Setup AP is on next to your Wi-Fi.">
          The device opened it for recovery. Anyone nearby can see <span className="mono">{net.ap_ssid}</span>.
        </Banner>
      )}
      <KeyValue items={items} />
      {change && <p className="nt-note">{change}</p>}
      <p className="nt-note">The device doesn&apos;t report which network it joined, so the network name isn&apos;t shown here.</p>
      <WifiMoveSection id={id} net={net} deviceName={deviceName} down={down} onChanged={onChanged} />
    </Card>
  );
}
