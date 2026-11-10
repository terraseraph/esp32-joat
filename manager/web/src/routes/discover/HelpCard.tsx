import { Search } from "lucide-react";
import { ButtonLink } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";

const INSTALLER_URL = "https://terraseraph.github.io/esp32-joat/";

/** The troubleshooting points, shared by the side card and the "no boards found" state. */
export function TroubleshootingList({ extra }: { extra?: boolean }) {
  return (
    <ul className="side-list">
      <li>Make sure the board is on the same network (subnet) as this PC.</li>
      <li>
        Windows often misses mDNS replies, so the sweep does the real work. A firewall prompt for the Manager can block it: allow it and scan again.
      </li>
      <li>VPNs and guest Wi-Fi networks hide devices from each other.</li>
      <li>
        A board on its Setup AP (<code>esp32-xxxxxx</code>, <span className="mono">192.168.4.1</span>) is only visible if this PC joins that Wi-Fi.
      </li>
      {extra && <li>You know the address? Try Add by IP.</li>}
    </ul>
  );
}

/** Shown when a finished scan found nothing at all. */
/** The page header already has the one "Scan again" button, so this card only links the installer. */
export function NothingFound({ subnets }: { subnets: string[] }) {
  return (
    <div className="empty nothing">
      <span className="ico">
        <Search className="i" aria-hidden="true" />
      </span>
      <h2>No boards found</h2>
      <p>
        {subnets.length
          ? `Scanned ${subnets.join(" and ")} and got no answer from any de-esp32 board.`
          : "The scan finished without an answer from any de-esp32 board."}
      </p>
      <TroubleshootingList extra />
      <div className="actions">
        <ButtonLink href={INSTALLER_URL}>Browser installer ↗</ButtonLink>
      </div>
    </div>
  );
}

export function HelpCard() {
  return (
    <Card aria-labelledby="help-h">
      <h2 id="help-h" className="side-h">
        Can't find a board?
      </h2>
      <TroubleshootingList />
      <p className="side-link">
        <a href={INSTALLER_URL} target="_blank" rel="noopener noreferrer">
          Flash a new board with the browser installer ↗
        </a>
      </p>
    </Card>
  );
}
