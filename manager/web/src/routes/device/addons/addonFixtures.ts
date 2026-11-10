import type { Hardware, HardwarePin, ModuleCatalog, ModuleInstance } from "@shared/device-api";

/** Test fixtures shared by the add-on tests (a trimmed DevKitC and the fake device's catalog). */
export function pin(gpio: number, over: Partial<HardwarePin> = {}): HardwarePin {
  return {
    gpio, input: true, output: true, pull: true, pwm: true, adc1: false, adc2: false, touch: false, dac: false, strap: false, flash: false,
    input_only: false, status_led: false, boot_btn: false, adc_channel: -1, touch_channel: -1, role: "", notes: "", owner: "", ...over,
  };
}

export function makeHardware(owners: Record<number, string> = {}): Hardware {
  const gpios = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35];
  const pins = gpios.map((g) =>
    pin(g, {
      strap: g === 5 || g === 12 || g === 15 || g === 2,
      input_only: g === 34 || g === 35,
      output: !(g === 34 || g === 35),
      owner: owners[g] ?? "",
    }),
  );
  pins.push(pin(6, { flash: true }));
  return {
    board_id: "devkitc", board_name: "ESP32 DevKitC", status_led_gpio: 2, status_led_active_high: true, boot_gpio: 0,
    header: { usb: "bottom", left: [], right: [] },
    buses: [
      { id: "vspi", kind: "spi", label: "VSPI", pins: { sck: 18, miso: 19, mosi: 23, ss: 5 } },
      { id: "hspi", kind: "spi", label: "HSPI", pins: { sck: 14, miso: 12, mosi: 13, ss: 15 } },
      { id: "i2c0", kind: "i2c", label: "I2C 0", pins: { sda: 21, scl: 22 } },
      { id: "uart0", kind: "uart", label: "UART0", pins: { tx: 1, rx: 3 } },
    ],
    chip: "ESP32", chip_info: { model: "ESP32", revision: 1, cores: 2, features: [] } as unknown as Hardware["chip_info"], pins,
  };
}

export const CATALOG: ModuleCatalog = {
  types: [
    {
      type: "bme280", label: "BME280", summary: "Temperature, pressure and humidity sensor (I2C)", bus: "i2c", default_bus: "i2c0", id_prefix: "env", max_instances: 2,
      pins: [
        { role: "sda", required: true, share: "bus", cap: "out" },
        { role: "scl", required: true, share: "bus", cap: "out" },
      ],
      settings: [
        { key: "addr", label: "I2C address", kind: "enum", def: 118, choices: [{ value: 118, label: "0x76" }, { value: 119, label: "0x77" }] },
        { key: "sample_ms", label: "Sample interval (ms)", kind: "int", def: 1000, min: 100, max: 60000 },
        { key: "mode", label: "Mode", kind: "enum", def: "normal", choices: [{ value: "normal", label: "Normal" }, { value: "forced", label: "Forced" }] },
      ],
    },
    {
      type: "mfrc522", label: "MFRC522 RFID reader", summary: "13.56 MHz RFID reader (SPI)", bus: "spi", default_bus: "vspi", id_prefix: "rfid", max_instances: 4,
      pins: [
        { role: "sck", required: true, share: "bus", cap: "out" },
        { role: "miso", required: true, share: "bus", cap: "in" },
        { role: "mosi", required: true, share: "bus", cap: "out" },
        { role: "ss", required: true, share: "instance", cap: "out" },
        { role: "rst", required: false, share: "instance", cap: "out" },
      ],
      settings: [
        { key: "poll_ms", label: "Poll interval (ms)", kind: "int", def: 100, min: 20, max: 2000 },
        { key: "rx_gain", label: "Receiver gain", kind: "int", def: 4, min: 0, max: 7 },
      ],
    },
  ],
};

export const ENV0: ModuleInstance = {
  id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 }, settings: { addr: 118, sample_ms: 1000, mode: "normal" },
  state: { id: "env0", type: "bme280", ok: true, addr: 118, t_c: 23.4, p_hpa: 1011, rh: 48 },
};

export const RFID0: ModuleInstance = {
  id: "rfid0", type: "mfrc522", bus: "vspi", enabled: true, pins: { sck: 18, miso: 19, mosi: 23, ss: 5, rst: 27 }, settings: { poll_ms: 100, rx_gain: 4 },
  state: { id: "rfid0", type: "mfrc522", present: false, uid: "", version: 146, tx: 3 },
};
