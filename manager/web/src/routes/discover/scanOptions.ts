import type { ScanRequest } from "@shared/api";
import { splitList } from "./hostInput";

export interface ScanOptions {
  mdns: boolean;
  sweep: boolean;
  /** CIDR ranges, comma / space separated. */
  subnets: string;
  /** host[:port] addresses, comma / space separated. */
  targets: string;
}

export const DEFAULT_OPTIONS: ScanOptions = { mdns: true, sweep: true, subnets: "", targets: "" };

/** The `POST /api/discovery/scan` body for the form values. */
export function toScanRequest(o: ScanOptions): ScanRequest {
  const subnets = splitList(o.subnets);
  const targets = splitList(o.targets);
  return { mdns: o.mdns, sweep: o.sweep, ...(subnets.length ? { subnets } : {}), ...(targets.length ? { targets } : {}) };
}
