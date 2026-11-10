import type { DiscoveryResult, DiscoveryState } from "@shared/api";

export interface IgnoredEntry {
  id: string;
  /** The result from the last scan, when the board was seen (gives a name and address). */
  result?: DiscoveryResult;
}

export interface DiscoveryGroups {
  /** Not in the fleet, not ignored, normal network state. */
  fresh: DiscoveryResult[];
  /** Not in the fleet, not ignored, but in setup / recovery (Setup AP open). */
  setup: DiscoveryResult[];
  /** Already in the fleet (IP changes first). */
  known: DiscoveryResult[];
  ignored: IgnoredEntry[];
}

/** Pure: split a discovery state into the four result groups shown on the Discover screen. */
export function groupResults(state: Pick<DiscoveryState, "results" | "ignored">): DiscoveryGroups {
  const fresh: DiscoveryResult[] = [];
  const setup: DiscoveryResult[] = [];
  const known: DiscoveryResult[] = [];
  const ignoredIds = new Set<string>(state.ignored);
  const byId = new Map<string, DiscoveryResult>();

  for (const r of state.results) {
    byId.set(r.id, r);
    if (r.classification === "ignored") ignoredIds.add(r.id);
    else if (r.classification === "known") known.push(r);
    else if (r.setup) setup.push(r);
    else fresh.push(r);
  }
  // A stable sort that lifts rows with an address change to the top.
  known.sort((a, b) => Number(Boolean(b.ipChanged)) - Number(Boolean(a.ipChanged)));

  const ignored: IgnoredEntry[] = [...ignoredIds].map((id) => ({ id, result: byId.get(id) }));
  return { fresh, setup, known, ignored };
}

export function isRunningPhase(phase: DiscoveryState["phase"]): boolean {
  return phase === "mdns" || phase === "sweep";
}
