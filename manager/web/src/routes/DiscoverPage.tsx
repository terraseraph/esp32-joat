import { AlertTriangle, Check, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { PageHeader } from "../components/ui/PageHeader";
import { AdvancedOptions } from "./discover/AdvancedOptions";
import "./discover/discover.css";
import { scanIssues } from "./discover/errors";
import { groupResults } from "./discover/grouping";
import { HelpCard, NothingFound } from "./discover/HelpCard";
import { ManualAdd } from "./discover/ManualAdd";
import { ResultGroups, WaitingCard } from "./discover/ResultGroups";
import { DEFAULT_OPTIONS, toScanRequest, type ScanOptions } from "./discover/scanOptions";
import { ScanCard } from "./discover/ScanCard";
import { SetupSection } from "./discover/setup";
import { useDiscovery } from "./discover/useDiscovery";

export function DiscoverPage() {
  const d = useDiscovery();
  const [options, setOptions] = useState<ScanOptions>(DEFAULT_OPTIONS);
  const { state } = d;

  const groups = useMemo(() => (state ? groupResults(state) : null), [state]);
  const running = state?.running ?? false;
  const issues = d.startError?.code === "invalid_body" ? scanIssues(d.startError) : null;
  const generalError = d.startError && !issues ? d.startError : d.actionError;

  const startScan = () => void d.scan(toScanRequest(options));
  const warnings = state?.warnings ?? [];
  const empty = groups !== null && !groups.fresh.length && !groups.setup.length && !groups.known.length && !groups.ignored.length;
  const finished = state !== null && (state.phase === "done" || state.phase === "cancelled");

  const advanced = <AdvancedOptions value={options} onChange={setOptions} disabled={running || d.starting} issues={issues} />;

  let results = null;
  if (state && groups) {
    if (running && empty) results = <WaitingCard />;
    else if (finished && empty)
      results = (
        <Card>
          <NothingFound subnets={state.subnets} />
        </Card>
      );
    else if (!empty)
      results = <ResultGroups groups={groups} busy={d.busy} onAdd={(ids) => void d.adopt(ids)} onIgnore={(id) => void d.ignore(id)} onUnignore={(id) => void d.unignore(id)} />;
  }

  return (
    <>
      <PageHeader
        title="Discover"
        description="Find de-esp32 boards on this network"
        actions={
          state && state.phase !== "idle" ? (
            <Button variant="primary" onClick={startScan} disabled={running || d.starting} aria-busy={d.starting}>
              <RefreshCw className="i" aria-hidden="true" />
              Scan again
            </Button>
          ) : undefined
        }
      />

      {!state && !d.loadError && (
        <Card aria-busy="true" aria-label="Loading scan status">
          <div className="stack">
            <span className="skeleton title" />
            <span className="skeleton line" />
            <span className="skeleton line" />
          </div>
        </Card>
      )}
      {!state && d.loadError && (
        <Card>
          <div className="banner bad" role="alert">
            <AlertTriangle className="i" aria-hidden="true" />
            <div className="txt">
              <strong>Could not load the scan status</strong>
              <div className="mut">{d.loadError.message}</div>
            </div>
            <div className="act">
              <Button size="sm" onClick={d.reload}>
                <RefreshCw className="i sm" aria-hidden="true" />
                Retry
              </Button>
            </div>
          </div>
        </Card>
      )}
      {state && <ScanCard state={state} starting={d.starting} onScan={startScan} onCancel={() => void d.cancel()} advanced={advanced} />}

      {state && warnings.length > 0 && state.phase !== "error" && (
        <div className="banner warn disc-warn" role="status">
          <AlertTriangle className="i" aria-hidden="true" />
          <div className="txt">
            <strong>{warnings.length === 1 ? "Heads up" : "Heads up on this scan"}</strong>
            <ul className="warn-list">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {generalError && (
        <div className="banner bad" role="alert">
          <AlertTriangle className="i" aria-hidden="true" />
          <div className="txt">{generalError.message}</div>
          {d.startError && !issues && (
            <div className="act">
              <Button size="sm" onClick={startScan} disabled={d.starting}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}
      {d.notice && (
        <div className={`banner ${d.notice.tone}`} role="status">
          {d.notice.tone === "ok" ? <Check className="i" aria-hidden="true" /> : <AlertTriangle className="i" aria-hidden="true" />}
          <div className="txt">{d.notice.text}</div>
          <div className="act">
            <Button size="sm" variant="ghost" iconOnly aria-label="Dismiss" onClick={d.dismissNotice}>
              <X className="i sm" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      <SetupSection />

      <div className="disc">
        <div className="disc-main">{results}</div>
        <aside className="disc-side" aria-label="Add by IP and help">
          <ManualAdd onAdded={d.reload} />
          <HelpCard />
        </aside>
      </div>
    </>
  );
}
