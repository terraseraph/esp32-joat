import type { Hardware, HardwarePin, HeaderPad } from "@shared/device-api";
import { Chip, Pulse, Segmented } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { liveValueText, matchesFilter, MODE_LABEL, ownerExplanation, pinLabel, type LiveIo, type PinFilter, type PinUse } from "./pinLogic";

export interface PinListProps {
  hardware: Hardware;
  padsByGpio: ReadonlyMap<number, HeaderPad>;
  uses: ReadonlyMap<number, PinUse>;
  io: LiveIo | undefined;
  filter: PinFilter;
  onFilter: (f: PinFilter) => void;
  selected: number | null;
  onSelect: (gpio: number) => void;
  disabled?: boolean;
}

export function countUses(uses: Iterable<PinUse>): Record<PinFilter, number> {
  const c: Record<PinFilter, number> = { all: 0, used: 0, free: 0 };
  for (const u of uses) {
    c.all++;
    if (matchesFilter(u, "used")) c.used++;
    else if (matchesFilter(u, "free")) c.free++;
  }
  return c;
}

function Right({ pin, use, io }: { pin: HardwarePin; use: PinUse; io: LiveIo | undefined }) {
  if (use.kind === "flash") return <Chip tone="off">Reserved</Chip>;
  if (use.kind === "free") return <span className="free">Free</span>;
  if (use.kind === "addon") return <Chip>Add-on {use.id}</Chip>;
  if (use.kind === "bus") return <Chip>Bus {use.id.toUpperCase()}</Chip>;
  const value = liveValueText(use, pin, io);
  return (
    <span className="right">
      <Chip tone="acc">{MODE_LABEL[use.mode]}</Chip>
      {value && (
        <Pulse trigger={value} className="val">
          {value}
        </Pulse>
      )}
    </span>
  );
}

/** Filterable list of every pin with its mode, owner and live value; shares the selection with the pinout. */
export function PinList({ hardware, padsByGpio, uses, io, filter, onFilter, selected, onSelect, disabled }: PinListProps) {
  const counts = countUses(uses.values());
  const rows = [...hardware.pins].sort((a, b) => a.gpio - b.gpio).filter((p) => matchesFilter(uses.get(p.gpio) ?? { kind: "free" }, filter));
  return (
    <>
      <div className="card-head">
        <h3 id="plist-h">Pin list</h3>
        <Segmented<PinFilter>
          aria-label="Filter pins"
          value={filter}
          onChange={onFilter}
          options={[
            { value: "all", label: `All ${counts.all}` },
            { value: "used", label: `Used ${counts.used}` },
            { value: "free", label: `Free ${counts.free}` },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <p className="mut">{filter === "used" ? "No pin is in use yet. Pick a free pad to set one up." : "No free pins."}</p>
      ) : (
        <ul className="pn-plist" aria-labelledby="plist-h">
          {rows.map((pin) => {
            const use = uses.get(pin.gpio) ?? ({ kind: "free" } as PinUse);
            const label = pinLabel(pin, padsByGpio.get(pin.gpio));
            const owner = ownerExplanation(pin, hardware.buses);
            return (
              <li key={pin.gpio}>
                <button type="button" className={cx("pn-pl", selected === pin.gpio && "sel")} data-gpio={pin.gpio} disabled={use.kind === "flash" || disabled} onClick={() => onSelect(pin.gpio)}>
                  <span>
                    <span className="strong">GPIO {pin.gpio}</span>
                    {label && <span className="mut"> · {label}</span>}{" "}
                    {pin.strap && (
                      <span className="pn-fg" title="Strapping pin" aria-label="strapping pin">
                        S
                      </span>
                    )}
                    {pin.input_only && (
                      <span className="pn-fg io" title="Input-only" aria-label="input-only">
                        I
                      </span>
                    )}
                    {owner && <span className="own">{owner}</span>}
                    <span className="nt">{use.kind === "flash" ? "SPI flash, reserved" : pin.notes}</span>
                  </span>
                  <Right pin={pin} use={use} io={io} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
