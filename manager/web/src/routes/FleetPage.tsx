import type { DeviceSummary } from "@shared/api";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../api/client";
import { setDevices, useDevices } from "../api/devices";
import { Banner, InlineError, PageHeader } from "../components/ui";
import { BulkBar, HeaderActions, SummaryStrip, Toolbar } from "./fleet/Controls";
import { DeviceCard } from "./fleet/DeviceCard";
import { DeviceTable } from "./fleet/DeviceTable";
import "./fleet/fleet.css";
import { filterCounts, filterDevices, loadPrefs, savePrefs, sortDevices, summarize, type FleetFilter, type FleetPrefs, type FleetSort, type FleetView } from "./fleet/logic";
import { AllOfflineBanner, EmptyFleet, FleetSkeleton, NoMatches } from "./fleet/States";
import { useFleetActions } from "./fleet/useFleetActions";

/** Re-render relative times ("Last seen 5 min ago") without a data change. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function FleetPage() {
  const { list, loaded, error } = useDevices();
  const navigate = useNavigate();
  const actions = useFleetActions();
  const now = useNow();
  // Unknown (health not loaded yet) counts as on; only an explicit false changes the wording.

  const [prefs, setPrefs] = useState<FleetPrefs>(loadPrefs);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const updatePrefs = (patch: Partial<FleetPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const summary = useMemo(() => summarize(list), [list]);
  const counts = useMemo(() => filterCounts(list), [list]);
  // "Differs" only means something once a target firmware exists.
  const activeFilter: FleetFilter = filter === "differs" && summary.differs === null ? "all" : filter;
  const visible = useMemo(() => sortDevices(filterDevices(list, activeFilter, query), prefs.sort), [list, activeFilter, query, prefs.sort]);

  // Selection only ever acts on devices that are on screen; ids of forgotten devices fall away by themselves.
  const selectedVisible = useMemo(() => visible.filter((d) => selected.has(d.id)), [visible, selected]);
  const selectedIds = useMemo(() => new Set(selectedVisible.map((d) => d.id)), [selectedVisible]);
  const hiddenCount = useMemo(() => list.filter((d) => selected.has(d.id)).length - selectedVisible.length, [list, selected, selectedVisible]);

  const toggle = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const selectAllVisible = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const d of visible) {
        if (on) next.add(d.id);
        else next.delete(d.id);
      }
      return next;
    });
  };
  const open = useCallback((id: string) => navigate(`/devices/${encodeURIComponent(id)}/live`), [navigate]);
  const goDiscover = () => navigate("/discover");

  const refreshAll = async (devices: readonly DeviceSummary[]) => {
    setRefreshing(true);
    try {
      await actions.refresh(devices);
    } finally {
      setRefreshing(false);
    }
  };

  const retryLoad = async () => {
    setRetrying(true);
    try {
      setDevices(await apiFetch<DeviceSummary[]>("/api/devices"));
    } catch {
      /* the error banner stays; the shell shows when the server is gone */
    } finally {
      setRetrying(false);
    }
  };

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  const allOffline = list.length > 0 && list.every((d) => d.health === "offline" || d.health === "unreachable");
  const hasDevices = list.length > 0;
  const description = !loaded ? "Health of every device at a glance" : list.length === 1 ? "1 device" : `${list.length} devices`;

  let body;
  if (!loaded && error) {
    body = (
      <Banner tone="bad" title="Could not load your devices">
        <InlineError message={error.message} onRetry={() => void retryLoad()} retrying={retrying} />
      </Banner>
    );
  } else if (!loaded) {
    body = <FleetSkeleton />;
  } else if (!hasDevices) {
    body = <EmptyFleet onScan={goDiscover} onAdd={goDiscover} />;
  } else {
    body = (
      <>
        <SummaryStrip summary={summary} filter={activeFilter} onFilter={setFilter} />
        {allOffline && <AllOfflineBanner onRetry={() => void refreshAll(list)} retrying={refreshing} />}
        <Toolbar
          query={query}
          onQuery={setQuery}
          filter={activeFilter}
          onFilter={setFilter}
          counts={counts}
          sort={prefs.sort}
          onSort={(sort: FleetSort) => updatePrefs({ sort })}
          view={prefs.view}
          onView={(view: FleetView) => updatePrefs({ view })}
        />
        {visible.length === 0 ? (
          <NoMatches onClear={clearFilters} />
        ) : prefs.view === "cards" ? (
          <div className="grid fleet-grid" style={{ "--min": "340px" } as React.CSSProperties}>
            <AnimatePresence initial={false}>
              {visible.map((d) => (
                <DeviceCard key={d.id} summary={d} selected={selectedIds.has(d.id)} now={now} onSelect={toggle} onOpen={open} actions={actions} />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <DeviceTable
            devices={visible}
            selected={selectedIds}
            sort={prefs.sort}
            now={now}
            onSort={(sort) => updatePrefs({ sort })}
            onSelect={toggle}
            onSelectAll={selectAllVisible}
            onOpen={open}
          />
        )}
        <BulkBar
          count={selectedVisible.length}
          hidden={hiddenCount}
          allVisible={visible.length > 0 && selectedVisible.length === visible.length}
          someVisible={selectedVisible.length > 0}
          busy={refreshing}
          onSelectAll={selectAllVisible}
          onRefresh={() => void refreshAll(selectedVisible)}
          onReboot={() => void actions.reboot(selectedVisible)}
          onForget={() => void actions.forget(selectedVisible)}
          onUpdate={() => navigate(`/firmware?devices=${selectedVisible.map((d) => encodeURIComponent(d.id)).join(",")}`)}
          onClear={() => setSelected(new Set())}
          backupDevices={selectedVisible}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Fleet"
        description={description}
        actions={<HeaderActions onScan={goDiscover} onAdd={goDiscover} onRefreshAll={() => void refreshAll(list)} refreshing={refreshing} hasDevices={loaded && hasDevices} />}
      />
      {body}
    </>
  );
}
