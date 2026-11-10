import type { DiscoveryState } from "@shared/api";
import { AlertTriangle, Check, Info, Radar, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { cx } from "../../lib/cx";
import { formatAgo } from "./display";
import { groupResults } from "./grouping";

const STEPS = ["mDNS", "Network sweep", "Done"] as const;

function stepIndex(phase: DiscoveryState["phase"]): number {
  if (phase === "mdns") return 0;
  if (phase === "sweep") return 1;
  return 2;
}

function phaseLabel(s: DiscoveryState): string {
  if (s.phase === "mdns") return "Asking the network with mDNS and checking known addresses";
  if (s.phase === "sweep") return `Checking every address on your local networks: ${s.probed} of ${s.total} probed`;
  return "";
}

export function ScanProgress({ phase, probed, total }: Pick<DiscoveryState, "phase" | "probed" | "total">) {
  const indeterminate = phase === "mdns" || total <= 0;
  const pct = total > 0 ? Math.min(100, Math.round((probed / total) * 100)) : 0;
  return (
    <div
      className={cx("progress", indeterminate && "ind")}
      role="progressbar"
      aria-label="Scan progress"
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : total}
      aria-valuenow={indeterminate ? undefined : probed}
      aria-valuetext={indeterminate ? "Looking for boards" : `${probed} of ${total} addresses probed`}
    >
      {indeterminate ? <i /> : <motion.i className="m" initial={false} animate={{ width: `${pct}%` }} transition={{ duration: 0.3, ease: "easeOut" }} />}
    </div>
  );
}

interface Props {
  state: DiscoveryState;
  starting: boolean;
  onScan(): void;
  onCancel(): void;
  /** false when the Manager runs with --no-network-scan (the scan only checks typed addresses and known boards). */
  networkScan?: boolean;
  /** The "Advanced" disclosure (hidden while a scan runs). */
  advanced: ReactNode;
}

/** The scan card: never scanned, scanning (progress, subnets, Cancel) or the summary of the last scan. */
export function ScanCard({ state, starting, onScan, onCancel, advanced, networkScan = true }: Props) {
  const { phase } = state;

  if (phase === "idle" && !state.running) {
    return (
      <Card aria-labelledby="scan-h" aria-live="polite">
        <h2 id="scan-h" className="sr">
          Scan
        </h2>
        <EmptyState
          icon={Radar}
          title="No scan yet"
          action={
            <div className="actions">
              <Button variant="primary" onClick={onScan} disabled={starting} aria-busy={starting}>
                <Radar className="i" aria-hidden="true" />
                {networkScan ? "Scan network" : "Check addresses"}
              </Button>
            </div>
          }
        >
          {networkScan
            ? "A scan asks your network for boards running de-esp32 (mDNS), then checks every address on your local networks. Nothing is added until you choose to. Results stay here until the next scan."
            : "Network scanning is off, so a scan only checks the addresses you list under Advanced and the boards already in your fleet. Nothing is added until you choose to."}
        </EmptyState>
        {advanced}
      </Card>
    );
  }

  if (state.running) {
    const step = stepIndex(phase);
    return (
      <Card aria-labelledby="scan-h" aria-live="polite" className="scan-card">
        <div className="scan-top">
          <div>
            <h2 id="scan-h" className="sr">
              Scan progress
            </h2>
            <ol className="steps" aria-label="Scan phases">
              {STEPS.map((label, i) => (
                <li key={label} className={cx(i < step && "done", i === step && "on")} aria-current={i === step ? "step" : undefined}>
                  {label}
                </li>
              ))}
            </ol>
          </div>
          <div className="scan-found">
            <span className="n num">{state.results.length}</span>
            <span className="mut strong">found</span>
          </div>
        </div>
        <div className="scan-bar">
          <ScanProgress phase={phase} probed={state.probed} total={state.total} />
          <p className="mut scan-phase">{phaseLabel(state)}</p>
        </div>
        {state.subnets.length > 0 && (
          <div className="scan-subnets">
            <span className="mut">Sweeping</span>
            <ul className="subnet-list" aria-label="Subnets being swept">
              {state.subnets.map((c) => (
                <li key={c} className="chip mono">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="scan-foot">
          <p>{networkScan ? "Windows often misses mDNS replies; the sweep checks every address on your local /24 networks." : "Checking the addresses you entered and the boards already in your fleet."}</p>
          <Button onClick={onCancel}>
            <X className="i" aria-hidden="true" />
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  // finished: done / cancelled / error
  const groups = groupResults(state);
  const fresh = groups.fresh.length + groups.setup.length;
  const when = formatAgo(state.finishedAt);
  // The page header carries the one "Scan again" button.
  return (
    <Card aria-labelledby="scan-h" aria-live="polite">
      <h2 id="scan-h" className="sr">
        Scan result
      </h2>
      {phase === "done" && (
        <div className="banner ok" role="status">
          <Check className="i" aria-hidden="true" />
          <div className="txt">
            <strong>Scan complete</strong>
            <div className="mut scan-sub">
              {fresh} new, {groups.known.length} already in fleet{when ? `. Finished ${when}` : ""}
            </div>
          </div>
        </div>
      )}
      {phase === "cancelled" && (
        <div className="banner warn" role="status">
          <Info className="i" aria-hidden="true" />
          <div className="txt">
            <strong>Scan cancelled</strong>
            <div className="mut scan-sub">{state.results.length} found before it stopped</div>
          </div>
        </div>
      )}
      {phase === "error" && (
        <div className="banner bad" role="alert">
          <AlertTriangle className="i" aria-hidden="true" />
          <div className="txt">
            <strong>The scan failed</strong>
            <div className="mut scan-sub">{state.warnings[0] ?? "The Manager could not finish scanning. Nothing was changed."}</div>
          </div>
        </div>
      )}
      {advanced}
    </Card>
  );
}
