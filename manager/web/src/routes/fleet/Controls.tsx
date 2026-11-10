import type { DeviceSummary } from "@shared/api";
import { LayoutGrid, List, Plus, Radar, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { useToastLift } from "../../lib/overlayState";
import { AnimatedNumber, Button, Checkbox, SearchInput, Select, Tooltip } from "../../components/ui";
import { cx } from "../../lib/cx";
import { attentionLabel } from "../../lib/format";
import { BulkBackupButton } from "../backups/BulkBackupButton";
import { SORT_OPTIONS, type FleetFilter, type FleetSort, type FleetSummary, type FleetView } from "./logic";

export const DIFFERS_HINT = "Choose a target firmware on the Firmware screen";

// ---- summary strip -------------------------------------------------------------------------------------

interface StatProps {
  label: string;
  value: number | null;
  hint: string;
  tone?: "ok" | "warn" | "bad";
  active: boolean;
  disabled?: boolean;
  tip?: string;
  onClick: () => void;
}

function Stat({ label, value, hint, tone, active, disabled, tip, onClick }: StatProps) {
  const body = (
    <button
      type="button"
      className={cx("stat fleet-stat", tone, active && "on", disabled && "is-disabled")}
      aria-pressed={disabled ? undefined : active}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
    >
      <span className="label">{label}</span>
      <span className="value">{value === null ? "—" : <AnimatedNumber value={value} />}</span>
      <span className="hint">{hint}</span>
    </button>
  );
  return tip ? <Tooltip label={tip}>{body}</Tooltip> : body;
}

export function SummaryStrip({ summary: s, filter, onFilter }: { summary: FleetSummary; filter: FleetFilter; onFilter: (f: FleetFilter) => void }) {
  const flagHint = s.flags.length === 0 ? "nothing to look at" : s.flags.slice(0, 2).map(attentionLabel).join(", ").toLowerCase() + (s.flags.length > 2 ? ` +${s.flags.length - 2}` : "");
  return (
    <section className="stats fleet-stats" aria-label="Fleet summary">
      <Stat label="Total" value={s.total} hint="devices in your fleet" active={filter === "all"} onClick={() => onFilter("all")} />
      <Stat
        label="Online"
        value={s.online}
        tone="ok"
        hint={s.onlineAttention > 0 ? `including ${s.onlineAttention} that ${s.onlineAttention === 1 ? "needs" : "need"} attention` : "answering right now"}
        active={filter === "online"}
        onClick={() => onFilter("online")}
      />
      <Stat
        label="Offline / unreachable"
        value={s.offline}
        hint={`${s.offlineOnly} offline · ${s.unreachable} unreachable`}
        active={filter === "offline"}
        onClick={() => onFilter("offline")}
      />
      <Stat label="Needs attention" value={s.attention} tone={s.attention > 0 ? "warn" : undefined} hint={flagHint} active={filter === "attention"} onClick={() => onFilter("attention")} />
      <Stat
        label="Firmware differs"
        value={s.differs}
        hint={s.differs === null ? "no target firmware chosen" : "vs the target firmware"}
        active={filter === "differs"}
        disabled={s.differs === null}
        tip={s.differs === null ? DIFFERS_HINT : undefined}
        onClick={() => onFilter("differs")}
      />
    </section>
  );
}

// ---- toolbar -------------------------------------------------------------------------------------------

const FILTERS: { value: FleetFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "attention", label: "Needs attention" },
  { value: "differs", label: "Differs" },
];

export interface ToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  filter: FleetFilter;
  onFilter: (f: FleetFilter) => void;
  counts: Record<FleetFilter, number | null>;
  sort: FleetSort;
  onSort: (s: FleetSort) => void;
  view: FleetView;
  onView: (v: FleetView) => void;
}

export function Toolbar({ query, onQuery, filter, onFilter, counts, sort, onSort, view, onView }: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Filter and sort devices">
      <SearchInput value={query} onChange={onQuery} placeholder="Search name, IP or ID" aria-label="Search name, label, hostname, IP or ID" />
      <div className="chips" role="group" aria-label="Filter">
        {FILTERS.map((f) => {
          const n = counts[f.value];
          const disabled = n === null;
          const btn = (
            <button
              key={f.value}
              type="button"
              className={cx("filter-chip", filter === f.value && "on", disabled && "is-disabled")}
              aria-pressed={filter === f.value}
              aria-disabled={disabled || undefined}
              onClick={() => !disabled && onFilter(f.value)}
            >
              {f.label}
              {n !== null && <span className="count">{n}</span>}
            </button>
          );
          return disabled ? (
            <Tooltip key={f.value} label={DIFFERS_HINT}>
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })}
      </div>
      <span className="spacer" />
      <Select value={sort} onChange={(v) => onSort(v as FleetSort)} aria-label="Sort by" className="fleet-sort-pick" options={SORT_OPTIONS.map((o) => ({ value: o.value, label: `Sort: ${o.label}` }))} />
      <div className="seg" role="group" aria-label="View">
        <button type="button" className={cx(view === "cards" && "on")} aria-pressed={view === "cards"} onClick={() => onView("cards")}>
          <LayoutGrid className="i sm" aria-hidden="true" />
          Cards
        </button>
        <button type="button" className={cx(view === "table" && "on")} aria-pressed={view === "table"} onClick={() => onView("table")}>
          <List className="i sm" aria-hidden="true" />
          Table
        </button>
      </div>
    </div>
  );
}

// ---- bulk bar ------------------------------------------------------------------------------------------

export interface BulkBarProps {
  /** Selected devices that are on screen. */
  count: number;
  /** Selected but filtered out (they are left alone). */
  hidden: number;
  allVisible: boolean;
  someVisible: boolean;
  busy: boolean;
  onSelectAll: (selected: boolean) => void;
  onRefresh: () => void;
  onReboot: () => void;
  onForget: () => void;
  /** Opens the Firmware screen with the selected devices ticked. */
  onUpdate: () => void;
  onClear: () => void;
  /** The selected devices the "Back up" button works on. */
  backupDevices?: readonly DeviceSummary[];
}

export function BulkBar({ count, hidden, allVisible, someVisible, busy, onSelectAll, onRefresh, onReboot, onForget, onUpdate, onClear, backupDevices }: BulkBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  useToastLift(barRef, count > 0);
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="bulk"
          ref={barRef}
          className="bulkbar fleet-bulk"
          role="region"
          aria-label="Bulk actions"
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 28 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        >
          <span className="count" aria-live="polite">
            {count} selected
            {hidden > 0 && <span className="mut"> ({hidden} hidden by the filter)</span>}
          </span>
          <Checkbox checked={allVisible} indeterminate={someVisible && !allVisible} onChange={onSelectAll} label="Select all shown" className="fleet-bulk-all" />
          <Button size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCw className="i sm" aria-hidden="true" />
            Refresh
          </Button>
          <Button size="sm" onClick={onReboot} disabled={busy}>
            Reboot
          </Button>
          <Button size="sm" variant="danger" onClick={onForget} disabled={busy}>
            Forget
          </Button>
          <Button size="sm" variant="primary" onClick={onUpdate} disabled={busy}>
            Update firmware…
          </Button>
          <BulkBackupButton devices={backupDevices ?? []} disabled={busy} />
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- header actions ------------------------------------------------------------------------------------

export function HeaderActions({ onScan, onAdd, onRefreshAll, refreshing, hasDevices, networkScan = true }: { networkScan?: boolean; onScan: () => void; onAdd: () => void; onRefreshAll: () => void; refreshing: boolean; hasDevices: boolean }) {
  return (
    <>
      {hasDevices && (
        <Button onClick={onRefreshAll} disabled={refreshing} aria-busy={refreshing || undefined}>
          <RefreshCw className="i" aria-hidden="true" />
          Refresh all
        </Button>
      )}
      <Button variant="primary" onClick={onScan}>
        <Radar className="i" aria-hidden="true" />
        {networkScan ? "Scan network" : "Check addresses"}
      </Button>
      <Button onClick={onAdd}>
        <Plus className="i" aria-hidden="true" />
        Add by IP
      </Button>
    </>
  );
}
