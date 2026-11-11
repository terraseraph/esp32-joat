import { AlertTriangle } from "lucide-react";
import { useId, useState } from "react";
import type { ScanIssues } from "./errors";
import type { ScanOptions } from "./scanOptions";

function Issues({ id, messages }: { id: string; messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="msg" id={id} style={{ display: "grid" }}>
      {messages.map((m) => (
        <span key={m} className="adv-msg">
          <AlertTriangle className="i sm" aria-hidden="true" />
          {m}
        </span>
      ))}
    </div>
  );
}

interface Props {
  value: ScanOptions;
  onChange(next: ScanOptions): void;
  disabled?: boolean;
  /** Field problems from the server's `400 invalid_body` (opens the disclosure). */
  issues: ScanIssues | null;
}

/** "Advanced" disclosure of the scan card: what to scan and extra places to look. */
export function AdvancedOptions({ value, onChange, disabled, issues }: Props) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const hasIssues = issues !== null;
  const [hadIssues, setHadIssues] = useState(false);
  if (hasIssues !== hadIssues) {
    // new server complaints open the disclosure so they are seen
    setHadIssues(hasIssues);
    if (hasIssues) setOpen(true);
  }

  const set = <K extends keyof ScanOptions>(k: K, v: ScanOptions[K]) => onChange({ ...value, [k]: v });
  const subnetsId = `${uid}-subnets`;
  const targetsId = `${uid}-targets`;

  return (
    <details className="disclosure adv" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Advanced</summary>
      <div className="adv-body">
        <fieldset className="adv-checks" disabled={disabled}>
          <legend className="sr">What to scan</legend>
          <label className="check">
            <input type="checkbox" checked={value.mdns} onChange={(e) => set("mdns", e.target.checked)} />
            Use mDNS
          </label>
          <label className="check">
            <input type="checkbox" checked={value.sweep} onChange={(e) => set("sweep", e.target.checked)} />
            Sweep local networks
          </label>
        </fieldset>
        <div className={issues?.subnets.length ? "field err" : "field"}>
          <label htmlFor={subnetsId}>Extra subnets</label>
          <input
            id={subnetsId}
            value={value.subnets}
            disabled={disabled}
            onChange={(e) => set("subnets", e.target.value)}
            placeholder="10.0.5.0/24, 172.16.0.0/24"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={issues?.subnets.length ? true : undefined}
            aria-describedby={issues?.subnets.length ? `${subnetsId}-msg` : `${subnetsId}-hint`}
          />
          <Issues id={`${subnetsId}-msg`} messages={issues?.subnets ?? []} />
          <div className="hint" id={`${subnetsId}-hint`}>
            CIDR ranges to sweep as well, separated by commas or spaces. Anything wider than /24 is cut down to the /24 around the address.
          </div>
        </div>
        <div className={issues?.targets.length ? "field err" : "field"}>
          <label htmlFor={targetsId}>Also probe addresses</label>
          <input
            id={targetsId}
            value={value.targets}
            disabled={disabled}
            onChange={(e) => set("targets", e.target.value)}
            placeholder="192.168.1.50, 127.0.0.1:8101"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={issues?.targets.length ? true : undefined}
            aria-describedby={issues?.targets.length ? `${targetsId}-msg` : `${targetsId}-hint`}
          />
          <Issues id={`${targetsId}-msg`} messages={issues?.targets ?? []} />
          <div className="hint" id={`${targetsId}-hint`}>
            <code>host</code> or <code>host:port</code>, checked exactly as given on every scan. Handy for boards on another network or a non-standard port.
          </div>
        </div>
        {issues && issues.other.length > 0 && (
          <div className="field err">
            <Issues id={`${uid}-other`} messages={issues.other} />
          </div>
        )}
      </div>
    </details>
  );
}
