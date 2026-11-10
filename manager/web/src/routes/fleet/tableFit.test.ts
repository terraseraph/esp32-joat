import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jsdom has no layout, so the "no sideways scroll at 1280px" rule is checked on the CSS itself: with the table in
 * `table-layout: fixed`, the visible columns' declared widths plus a minimum for the Name column must fit the table
 * container. At a 1280px viewport with the nav expanded the container is 1280 - 232 (nav) - 48 (padding) = 1000px
 * minus a scrollbar (~15px).
 */
const rel = "src/routes/fleet/fleet.css";
const file = [path.resolve(process.cwd(), rel), path.resolve(process.cwd(), "web", rel)].find((p) => existsSync(p)) ?? rel;
const css = readFileSync(file, "utf8");

const widths: Record<string, number> = { sel: 40 };
for (const m of css.matchAll(/th\.fleet-col-(\w+) \{ width: (\d+)px; \}/g)) widths[m[1]!] = Number(m[2]);
const hides = [...css.matchAll(/@container fleet-tbl \(max-width: ([\d.]+)px\) \{ \.fleet-col-(\w+) \{ display: none; \} \}/g)].map((m) => ({ below: Number(m[1]), col: m[2]! }));

const visibleAt = (container: number) => Object.keys(widths).filter((c) => !hides.some((h) => h.col === c && container <= h.below));
const fixedSum = (container: number) => visibleAt(container).reduce((n, c) => n + (widths[c] ?? 0), 0);
const NAME_MIN = 140;

describe("fleet table fit", () => {
  it("uses a fixed layout inside a size container", () => {
    expect(css).toMatch(/\.fleet-table-wrap \{ container: fleet-tbl \/ inline-size; \}/);
    expect(css).toMatch(/\.table\.fleet-table \{[^}]*table-layout: fixed;/);
  });

  it("fits at a 1280px viewport with the nav expanded (container ~985px) and at 800px (rail nav, ~670px)", () => {
    for (const container of [985, 967, 670]) expect(fixedSum(container) + NAME_MIN).toBeLessThanOrEqual(container);
  });

  it("fits at every container width above the table's minimum", () => {
    const min = Number(/min-width: (\d+)px; table-layout/.exec(css)?.[1]);
    expect(min).toBeGreaterThan(0);
    for (let w = min; w <= 2000; w += 5) expect(fixedSum(w) + NAME_MIN).toBeLessThanOrEqual(Math.max(w, min));
  });

  it("drops lower-priority columns first: Uptime, RSSI, Memory, MQTT", () => {
    expect(visibleAt(985)).not.toContain("uptime");
    expect(visibleAt(985)).not.toContain("rssi");
    expect(visibleAt(985)).toContain("memory");
    expect(visibleAt(1400)).toContain("uptime");
    expect(visibleAt(600)).not.toContain("mqtt");
    expect(visibleAt(600)).toContain("health");
  });
});
