import type { LogsResponse } from "@shared/device-api";
import { Download, List, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deviceGet } from "../../../api/commands";
import { Button } from "../../../components/ui/Button";
import { Card, CardHead } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { errorMessage, InlineError } from "../../../components/ui/InlineError";
import { Segmented } from "../../../components/ui/Segmented";
import { Spinner } from "../../../components/ui/Spinner";
import { useToast } from "../../../components/ui/Toast";
import { logFileName, logLevelClass, parseLogs, type LogLine } from "./helpers";

type Filter = "all" | "e" | "w";

export function filterLines(lines: readonly LogLine[], filter: Filter): LogLine[] {
  if (filter === "all") return [...lines];
  return lines.filter((l) => l.level === "e" || (filter === "w" && l.level === "w"));
}

const toText = (lines: readonly LogLine[]) => lines.map((l) => l.text).join("\n") + "\n";

/** Logs are fetched on demand only (the device is slow and keeps just the last 80 lines in RAM). */
export function LogsCard({ id, title, disabled }: { id: string; title: string; disabled: boolean }) {
  const toast = useToast();
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const view = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    deviceGet<LogsResponse>(id, "logs")
      .then((r) => setLines(parseLogs(r.lines ?? [])))
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  };

  const shown = useMemo(() => (lines ? filterLines(lines, filter) : []), [lines, filter]);
  useEffect(() => {
    const el = view.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toText(shown));
      toast({ tone: "ok", title: "Logs copied" });
    } catch {
      toast({ tone: "bad", title: "Could not copy the logs" });
    }
  };

  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([toText(shown)], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = logFileName(title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast({ tone: "bad", title: "Could not save the logs" });
    }
  };

  return (
    <Card aria-labelledby="sys-log-h" id="logs">
      <CardHead title={<span id="sys-log-h">Logs</span>} />
      {lines === null ? (
        <>
          {error ? (
            <InlineError message={error} onRetry={load} retrying={loading} />
          ) : (
            <EmptyState
              icon={List}
              title="Logs load on demand"
              action={
                <Button variant="primary" onClick={load} disabled={disabled || loading}>
                  {loading && <Spinner />}
                  Load logs
                </Button>
              }
            >
              The device keeps the last 80 lines in RAM; they're cleared on restart.
            </EmptyState>
          )}
        </>
      ) : (
        <>
          <div className="toolbar log-tools" role="toolbar" aria-label="Log tools">
            <Button onClick={load} disabled={disabled || loading} aria-busy={loading || undefined}>
              {loading ? <Spinner /> : <RefreshCw className="i" aria-hidden="true" />}
              Refresh
            </Button>
            <Segmented<Filter>
              aria-label="Filter by level"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "e", label: "Errors" },
                { value: "w", label: "Warnings", hint: "Warnings and errors" },
              ]}
            />
            <span className="spacer" />
            <Button onClick={() => void copy()} disabled={shown.length === 0}>
              Copy
            </Button>
            <Button onClick={download} disabled={shown.length === 0}>
              <Download className="i" aria-hidden="true" />
              Download .txt
            </Button>
          </div>
          {error && <InlineError message={error} onRetry={load} retrying={loading} />}
          <div className="log" ref={view} role="log" aria-label="Device log">
            {shown.map((l, i) => (
              <div key={i} className={logLevelClass(l.level)}>
                {l.text}
              </div>
            ))}
            {shown.length === 0 && <div className="lv-d">{lines.length === 0 ? "The log is empty." : "No lines at this level."}</div>}
          </div>
          <p className="log-foot">The device keeps the last 80 lines in RAM; they're cleared on restart.</p>
        </>
      )}
    </Card>
  );
}
