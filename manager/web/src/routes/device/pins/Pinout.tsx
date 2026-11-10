import type { Hardware, HardwarePin, HeaderPad } from "@shared/device-api";
import { Tooltip } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { MODE_LABEL, MODE_SHORT, ownerExplanation, pinLabel, type PinUse } from "./pinLogic";

export interface PinoutProps {
  hardware: Hardware;
  pinsByGpio: ReadonlyMap<number, HardwarePin>;
  uses: ReadonlyMap<number, PinUse>;
  selected: number | null;
  onSelect: (gpio: number) => void;
  /** Greys the pads and blocks clicks (device offline). */
  disabled?: boolean;
}

/** What the pad says about its pin, for the tooltip and the accessible name. */
export function describePin(pin: HardwarePin, pad: HeaderPad | undefined, use: PinUse, hardware: Pick<Hardware, "buses">): string {
  const label = pinLabel(pin, pad);
  const head = `GPIO ${pin.gpio}${label ? ` (${label})` : ""}`;
  const parts: string[] = [];
  if (use.kind === "flash") parts.push("reserved for SPI flash");
  else if (use.kind === "mode") parts.push(MODE_LABEL[use.mode]);
  else if (use.kind === "addon" || use.kind === "bus") parts.push(ownerExplanation(pin, hardware.buses).replace(/^Used by/, "in use by"));
  else parts.push("free");
  if (pin.input_only) parts.push("input-only");
  if (pin.strap) parts.push("strapping pin");
  if (pin.status_led) parts.push("status LED");
  if (pin.boot_btn) parts.push("BOOT button");
  return `${head}, ${parts.join(", ")}`;
}

function Pad({ pad, pin, use, hardware, selected, disabled, onSelect }: { pad: HeaderPad; pin: HardwarePin | undefined; use: PinUse | undefined; hardware: Hardware; selected: boolean; disabled: boolean; onSelect: (g: number) => void }) {
  if (pad.kind !== "gpio" || pad.gpio === null || !pin || !use) {
    return (
      <div className="pn-pad fixed">
        <span className="pn-sq" />
        <span className="pn-ps">{pad.silk}</span>
        <span className="pn-pt" />
      </div>
    );
  }
  const flash = use.kind === "flash";
  const text = use.kind === "mode" ? MODE_SHORT[use.mode] : use.kind === "addon" ? use.id : use.kind === "bus" ? use.id : "";
  const description = describePin(pin, pad, use, hardware);
  const button = (
    <button
      type="button"
      className={cx("pn-pad", flash ? "flash" : use.kind === "mode" ? "cfg" : use.kind === "free" ? "free" : "own", selected && "sel")}
      data-gpio={pin.gpio}
      data-mode={use.kind === "mode" ? use.mode : undefined}
      disabled={flash || disabled}
      aria-label={description}
      aria-pressed={selected}
      onClick={() => onSelect(pin.gpio)}
    >
      <span className="pn-sq" data-mode={use.kind === "mode" ? use.mode : undefined} />
      <span className="pn-ps">{pad.silk}</span>
      {pin.strap && (
        <span className="pn-fg" aria-hidden="true">
          S
        </span>
      )}
      {pin.input_only && (
        <span className="pn-fg io" aria-hidden="true">
          I
        </span>
      )}
      {pin.status_led && (
        <span className="pn-fg io" aria-hidden="true">
          LED
        </span>
      )}
      {pin.boot_btn && (
        <span className="pn-fg io" aria-hidden="true">
          BTN
        </span>
      )}
      <span className="pn-pt">{text}</span>
    </button>
  );
  // A disabled button gets no pointer events, so wrap it for the tooltip.
  return (
    <Tooltip label={pin.notes ? `${description}. ${pin.notes}` : description}>
      {disabled || flash ? <span className="pn-pad-wrap">{button}</span> : button}
    </Tooltip>
  );
}

/** Two 19-pad headers with the USB connector at the bottom; pads are coloured by mode / owner. */
export function Pinout({ hardware, pinsByGpio, uses, selected, onSelect, disabled }: PinoutProps) {
  const column = (pads: HeaderPad[], side: "left" | "right") => (
    <ul className={cx("pn-hdr", side)}>
      {pads.map((pad, i) => {
        const pin = pad.gpio === null ? undefined : pinsByGpio.get(pad.gpio);
        return (
          <li key={`${side}-${pad.i ?? i}`}>
            <Pad pad={pad} pin={pin} use={pin ? uses.get(pin.gpio) : undefined} hardware={hardware} selected={pin?.gpio === selected} disabled={Boolean(disabled)} onSelect={onSelect} />
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className={cx("pn-board", disabled && "is-disabled")} role="group" aria-label={`${hardware.board_name || "ESP32"} pinout, USB at the bottom`}>
      <div className="pn-b-top" aria-hidden="true">
        <div className="pn-b-ant">
          <span>Antenna</span>
        </div>
        <div className="pn-b-mod">{hardware.chip_info?.model ? `${hardware.chip_info.model} module` : "ESP32 module"}</div>
      </div>
      <div className="pn-b-cols">
        {column(hardware.header.left, "left")}
        <div className="pn-b-mid" aria-hidden="true">
          <span>{hardware.board_name || "DevKitC"}</span>
        </div>
        {column(hardware.header.right, "right")}
      </div>
      <div className="pn-b-usb" aria-hidden="true">
        {hardware.header.usb || "USB"}
      </div>
    </div>
  );
}

export function PinoutLegend() {
  return (
    <>
      <div className="pn-legend" aria-label="Legend">
        <span>
          <i className="pn-sq cfg" data-mode="out" />
          Output
        </span>
        <span>
          <i className="pn-sq cfg" data-mode="in" />
          Input
        </span>
        <span>
          <i className="pn-sq cfg" data-mode="pwm" />
          PWM
        </span>
        <span>
          <i className="pn-sq cfg" data-mode="servo" />
          Servo
        </span>
        <span>
          <i className="pn-sq cfg" data-mode="adc" />
          Analog
        </span>
        <span>
          <i className="pn-sq own" />
          Add-on or bus
        </span>
        <span>
          <i className="pn-sq" />
          Free
        </span>
        <span>
          <i className="pn-sq flash" />
          SPI flash, reserved
        </span>
        <span>
          <i className="pn-sq fix" />
          Power, GND, EN
        </span>
        <span>
          <i className="pn-fg" aria-hidden="true">
            S
          </i>
          Strapping pin
        </span>
        <span>
          <i className="pn-fg io" aria-hidden="true">
            I
          </i>
          Input-only
        </span>
      </div>
    </>
  );
}
