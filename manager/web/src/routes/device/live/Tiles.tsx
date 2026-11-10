import { motion } from "motion/react";
import { useState } from "react";
import { cx } from "../../../lib/cx";
import { AnimatedNumber, Chip, Pulse, Slider, Switch } from "../../../components/ui";
import { formatAddr, formatVolts, percentToDuty, type TileModel } from "./model";

export type SetPin = (kind: "out" | "pwm" | "servo", gpio: number, value: number) => Promise<boolean>;

interface TileProps {
  tile: TileModel;
  /** Controls cannot be used (offline, safe mode). */
  disabled: boolean;
  /** Last values of a device we cannot reach: greyed. */
  frozen: boolean;
  setPin: SetPin;
}

type Kind<K extends TileModel["kind"]> = Extract<TileModel, { kind: K }>;

const MODE_LABEL: Record<string, string> = { out: "Output", in: "Input", adc: "Analog", pwm: "PWM", servo: "Servo" };

function Title({ tile }: { tile: TileModel }) {
  const mode = MODE_LABEL[tile.kind];
  return (
    <span className="nm">
      <span>{mode ? `${mode} · ${tile.title}` : tile.title}</span>
    </span>
  );
}

function Hints({ tile }: { tile: TileModel }) {
  return (
    <>
      {tile.drivenBy && <div className="why">{tile.drivenBy}</div>}
      {tile.triggers && <div className="why">{tile.triggers}</div>}
    </>
  );
}

function OutputTile({ tile, disabled, setPin }: { tile: Kind<"out">; disabled: boolean; setPin: SetPin }) {
  const [optimistic, setOptimistic] = useState<0 | 1 | null>(null);
  const level = optimistic ?? tile.level;
  const busy = optimistic !== null;
  const toggle = (checked: boolean) => {
    const v = checked ? 1 : 0;
    setOptimistic(v);
    void setPin("out", tile.gpio, v).finally(() => setOptimistic(null));
  };
  return (
    <>
      <div className="top">
        <Title tile={tile} />
        <Switch checked={level === 1} onCheckedChange={toggle} disabled={disabled || busy} aria-label={tile.title} />
      </div>
      <div className="rd">{level === 1 ? "On" : "Off"}</div>
      <div className="foot">
        <span className={cx("led", level === 1 && "on")} aria-hidden="true" />
        <span className="sb">{tile.drivenBy ?? (level === 1 ? "High" : "Low")}</span>
      </div>
    </>
  );
}

function InputTile({ tile }: { tile: Kind<"in"> }) {
  return (
    <>
      <div className="top">
        <Title tile={tile} />
      </div>
      <div className="rd">
        <Pulse trigger={tile.level}>{tile.level === 1 ? "High" : "Low"}</Pulse>
      </div>
      {tile.debounceMs !== null && <div className="sb">Debounce {tile.debounceMs} ms</div>}
      <div className="foot">
        <span className={cx("led", tile.level === 1 && "on")} aria-hidden="true" />
        <span className="sb">{tile.triggers ?? "Not used by a rule"}</span>
      </div>
    </>
  );
}

function AnalogTile({ tile }: { tile: Kind<"adc"> }) {
  return (
    <>
      <div className="top">
        <Title tile={tile} />
      </div>
      <div className="rd">
        <AnimatedNumber value={tile.volts} format={formatVolts} /> <small>V</small>
      </div>
      <div className="sb">
        raw {tile.raw} · {tile.mv} mV
      </div>
      <Hints tile={tile} />
      <div className="progress" role="progressbar" aria-label={`${tile.title} level, 0 to 3.3 V`} aria-valuemin={0} aria-valuemax={3300} aria-valuenow={tile.mv}>
        <motion.i initial={false} animate={{ width: `${(tile.fraction * 100).toFixed(1)}%` }} transition={{ duration: 0.3, ease: "easeOut" }} />
      </div>
    </>
  );
}

function PwmTile({ tile, disabled, setPin }: { tile: Kind<"pwm">; disabled: boolean; setPin: SetPin }) {
  const [drag, setDrag] = useState<number | null>(null);
  const percent = drag ?? tile.percent;
  return (
    <>
      <div className="top">
        <Title tile={tile} />
      </div>
      <div className="rd">
        <span className="num">{percent}</span> <small>%</small>
      </div>
      <div className="sb">
        duty {drag === null ? tile.duty : percentToDuty(drag)} / 1000 · {tile.hz} Hz
      </div>
      <div className="why">Frequency is shared by all PWM pins</div>
      <Hints tile={tile} />
      <div className="slider">
        <Slider
          value={percent}
          min={0}
          max={100}
          step={1}
          hideValue
          aria-label={`${tile.title} duty, 0 to 100 percent`}
          disabled={disabled}
          onChange={setDrag}
          onCommit={(p) => {
            setDrag(p);
            void setPin("pwm", tile.gpio, percentToDuty(p)).finally(() => setDrag(null));
          }}
        />
      </div>
    </>
  );
}

function ServoTile({ tile, disabled, setPin }: { tile: Kind<"servo">; disabled: boolean; setPin: SetPin }) {
  const [drag, setDrag] = useState<number | null>(null);
  const angle = drag ?? tile.angle;
  return (
    <>
      <div className="top">
        <Title tile={tile} />
      </div>
      <div className="rd">
        <span className="num">{angle}</span>
        <small>°</small>
      </div>
      <div className="sb">{drag === null ? `${tile.pulseUs} µs` : "…"}</div>
      <Hints tile={tile} />
      <div className="slider">
        <Slider
          value={angle}
          min={0}
          max={180}
          step={1}
          hideValue
          aria-label={`${tile.title} angle, 0 to 180 degrees`}
          disabled={disabled}
          onChange={setDrag}
          onCommit={(a) => {
            setDrag(a);
            void setPin("servo", tile.gpio, a).finally(() => setDrag(null));
          }}
        />
      </div>
    </>
  );
}

function BmeTile({ tile }: { tile: Kind<"bme280"> }) {
  return (
    <>
      <div className="top">
        <span>{tile.title}</span>
        <Chip tone={tile.ok ? "ok" : "warn"}>{tile.ok ? "OK" : "No sensor"}</Chip>
      </div>
      {tile.ok && tile.tempC !== null ? (
        <>
          <div className="rd">
            <AnimatedNumber value={tile.tempC} format={(n) => n.toFixed(1)} /> <small>°C</small>
          </div>
          <div className="sb">
            {tile.humidity !== null && (
              <>
                <AnimatedNumber value={tile.humidity} format={(n) => n.toFixed(1)} /> % humidity
              </>
            )}
            {tile.pressureHpa !== null && (
              <>
                {" · "}
                <AnimatedNumber value={tile.pressureHpa} format={(n) => n.toFixed(1)} /> hPa
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="rd">No sensor</div>
          <div className="sb">Check SDA/SCL wiring (address {formatAddr(tile.addr)})</div>
        </>
      )}
      <div className="sb">{[`I²C ${formatAddr(tile.addr)}`, tile.wiring?.replace(/^I²C \d+ · /, "")].filter(Boolean).join(" · ")}</div>
    </>
  );
}

function readerMissing(t: Kind<"mfrc522">): boolean {
  return !t.present && (t.version === 0 || t.version === 0xff);
}

function RfidTile({ tile }: { tile: Kind<"mfrc522"> }) {
  const missing = readerMissing(tile);
  return (
    <>
      <div className="top">
        <span>{tile.title}</span>
        {missing ? <Chip tone="warn">Reader not found</Chip> : <Chip tone={tile.present ? "ok" : "off"}>{tile.present ? "Tag present" : "No tag"}</Chip>}
      </div>
      <div className="rd uid">
        <span className={cx("led", tile.present && "on")} aria-hidden="true" />
        {missing ? (
          "Reader not found"
        ) : (
          <Pulse trigger={tile.uid}>{tile.present && tile.uid ? tile.uid : "No tag"}</Pulse>
        )}
      </div>
      <div className="sb">{missing ? "Check the SPI wiring and power" : `Reader v0x${tile.version.toString(16).toUpperCase()} · ${tile.present ? "tag present" : "waiting for a tag"}`}</div>
      {tile.wiring && <div className="sb">{tile.wiring}</div>}
    </>
  );
}

function tone(tile: TileModel): string | false {
  switch (tile.kind) {
    case "out":
      return tile.level === 1 && "on";
    case "pwm":
      return tile.duty > 0 && "on";
    case "servo":
      return "on";
    case "bme280":
      return tile.ok ? "ok" : "warn";
    case "mfrc522":
      return readerMissing(tile) ? "warn" : tile.present && "ok";
    default:
      return false;
  }
}

/** One channel. Incoming values update it in place; a slider being dragged keeps its own value until the device answers. */
export function LiveTile({ tile, disabled, frozen, setPin }: TileProps) {
  let body;
  switch (tile.kind) {
    case "out":
      body = <OutputTile tile={tile} disabled={disabled} setPin={setPin} />;
      break;
    case "in":
      body = <InputTile tile={tile} />;
      break;
    case "adc":
      body = <AnalogTile tile={tile} />;
      break;
    case "pwm":
      body = <PwmTile tile={tile} disabled={disabled} setPin={setPin} />;
      break;
    case "servo":
      body = <ServoTile tile={tile} disabled={disabled} setPin={setPin} />;
      break;
    case "bme280":
      body = <BmeTile tile={tile} />;
      break;
    case "mfrc522":
      body = <RfidTile tile={tile} />;
      break;
  }
  return (
    <motion.div
      className={cx("tile", tone(tile), frozen && "is-offline")}
      data-key={tile.key}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      {body}
    </motion.div>
  );
}
