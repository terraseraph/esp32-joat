import type { MemoryInfo } from "@shared/device-api";
import { Banner } from "../../../components/ui/Banner";
import { AnimatedNumber } from "../../../components/ui/AnimatedNumber";
import { Card, CardHead } from "../../../components/ui/Card";
import { Chip } from "../../../components/ui/Chip";
import { KeyValue } from "../../../components/ui/KeyValue";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { formatBytes } from "../../../lib/format";
import { isLowBlock, isLowStack, LOW_STACK_BYTES, pressureLabel, pressureTone, usedPercent } from "./helpers";

const bytes = (n: number) => formatBytes(n);

function psramText(p: NonNullable<MemoryInfo["psram"]>): string {
  if (typeof p.total === "number" && typeof p.free === "number") return `${formatBytes(p.free)} free of ${formatBytes(p.total)}`;
  return "Present";
}

export function MemoryCard({ memory, disabled }: { memory: MemoryInfo | null; disabled: boolean }) {
  if (!memory) {
    return (
      <Card aria-labelledby="sys-mem-h">
        <CardHead title={<span id="sys-mem-h">Memory</span>} />
        <p className="mut">No memory data yet.</p>
      </Card>
    );
  }
  const heap = memory.internal;
  const pct = usedPercent(heap.used, heap.total);
  const tone = memory.pressure === "critical" ? "bad" : memory.pressure === "warn" ? "warn" : undefined;
  const lowBlock = isLowBlock(heap.largest);
  return (
    <Card aria-labelledby="sys-mem-h" className={disabled ? "sys-off" : undefined}>
      <CardHead title={<span id="sys-mem-h">Memory</span>} actions={<Chip tone={pressureTone(memory.pressure)}>{pressureLabel(memory.pressure)}</Chip>} />
      <div className="row" style={{ marginBottom: "var(--s2)" }}>
        <span className="strong">Internal heap</span>
        <span className="spacer" />
        <span className="mut num">
          <AnimatedNumber value={heap.used} format={bytes} /> used of {formatBytes(heap.total)} ({Math.round(pct)}%)
        </span>
      </div>
      <ProgressBar value={pct} tone={tone} label="Internal heap used" />
      {memory.alloc_failed && (
        <div style={{ marginTop: "var(--s3)" }}>
          <Banner tone="warn" title="A memory allocation failed">
            The device could not allocate {formatBytes(memory.alloc_failed_size)} since it started.
          </Banner>
        </div>
      )}
      {lowBlock && (
        <div style={{ marginTop: "var(--s3)" }}>
          <Banner tone="warn">Largest free block under 48 KB. Adding add-ons may fail.</Banner>
        </div>
      )}
      <KeyValue
        className="kv-after"
        items={[
          { label: "Free", value: <AnimatedNumber value={heap.free} format={bytes} /> },
          { label: "Lowest ever", value: <AnimatedNumber value={heap.min} format={bytes} /> },
          { label: "Largest block", value: <span className={lowBlock ? "t-warn strong" : undefined}>{formatBytes(heap.largest)}</span> },
          { label: "Reserve", value: formatBytes(memory.reserve) },
          {
            label: "DMA free",
            value: (
              <>
                <AnimatedNumber value={memory.dma.free} format={bytes} /> <span className="mut">(largest {formatBytes(memory.dma.largest)})</span>
              </>
            ),
          },
          { label: "PSRAM", value: memory.psram ? psramText(memory.psram) : "None" },
          { label: "Allocation failures", value: memory.alloc_failed ? <span className="t-warn strong">Yes</span> : "None" },
        ]}
      />
      <details className="fold">
        <summary>Boot stages</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="num">Free</th>
                <th className="num">Largest block</th>
              </tr>
            </thead>
            <tbody>
              {memory.boot.map((b) => (
                <tr key={b.stage}>
                  <td className="mono">{b.stage}</td>
                  <td className="num">{formatBytes(b.free)}</td>
                  <td className="num">{formatBytes(b.largest)}</td>
                </tr>
              ))}
              {memory.boot.length === 0 && (
                <tr>
                  <td colSpan={3} className="mut">
                    No boot stages reported.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      <details className="fold">
        <summary>Task stacks</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th className="num">Lowest free stack</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...memory.tasks]
                .sort((a, b) => b.stack_min - a.stack_min)
                .map((t) => (
                  <tr key={t.name}>
                    <td className="mono">{t.name}</td>
                    <td className={isLowStack(t.stack_min) ? "num t-warn strong" : "num"}>{t.stack_min.toLocaleString("en-US")} B</td>
                    <td>{isLowStack(t.stack_min) && <Chip tone="warn">Low</Chip>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p>
          Smallest amount of stack each task has ever had left, in bytes. Values under {LOW_STACK_BYTES.toLocaleString("en-US")} are highlighted.
          {memory.tasks_truncated ? " The list is cut off at 24 tasks." : ""}
        </p>
      </details>
    </Card>
  );
}
