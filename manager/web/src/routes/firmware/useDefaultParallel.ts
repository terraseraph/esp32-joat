import type { SettingsResponse } from "@shared/api";
import { useState } from "react";
import { useApi } from "../../api/useApi";

const FALLBACK = 2;

/**
 * The "Parallel updates" value of the Firmware screen. It starts at the `defaultParallelUpdates` setting
 * (`GET /api/settings`, 1-4) and follows it until the user picks a number; the Manager's default (2) is used while
 * the setting is loading or cannot be read. Returns the value as the select's string and a setter.
 */
export function useParallelUpdates(): [string, (v: string) => void] {
  const settings = useApi<Pick<SettingsResponse, "defaultParallelUpdates">>("/api/settings");
  const [picked, setPicked] = useState<string | null>(null);
  const fromSettings = settings.data?.defaultParallelUpdates;
  const initial = typeof fromSettings === "number" && fromSettings >= 1 && fromSettings <= 4 ? fromSettings : FALLBACK;
  return [picked ?? String(initial), setPicked];
}
