"use strict";

/** Snapshot of GET /api/v1/hardware for ESP32-WROOM-32 DevKitC (same flags as firmware). */

function pad(silk, gpio, kind) {
  return { silk, gpio: gpio == null ? null : gpio, kind };
}

function pin(gpio, extra) {
  return Object.assign(
    {
      gpio,
      input: false,
      output: false,
      pull: false,
      pwm: false,
      adc1: false,
      adc2: false,
      touch: false,
      dac: false,
      strap: false,
      flash: false,
      input_only: false,
      status_led: false,
      boot_btn: false,
      adc_channel: -1,
      touch_channel: -1,
      role: "",
      notes: "",
    },
    extra,
  );
}

const io = { input: true, output: true, pull: true, pwm: true };
const inOnly = { input: true, input_only: true };

function snapshot() {
  return {
    board_id: "esp32-devkitc",
    board_name: "ESP32-WROOM-32 DevKitC",
    status_led_gpio: 2,
    status_led_active_high: true,
    boot_gpio: 0,
    chip: "ESP32",
    header: {
      usb: "bottom",
      left: [
        pad("3V3", null, "power"),
        pad("EN", null, "en"),
        pad("VP", 36, "gpio"),
        pad("VN", 39, "gpio"),
        pad("34", 34, "gpio"),
        pad("35", 35, "gpio"),
        pad("32", 32, "gpio"),
        pad("33", 33, "gpio"),
        pad("25", 25, "gpio"),
        pad("26", 26, "gpio"),
        pad("27", 27, "gpio"),
        pad("14", 14, "gpio"),
        pad("12", 12, "gpio"),
        pad("GND", null, "gnd"),
        pad("13", 13, "gpio"),
        pad("D2", 9, "gpio"),
        pad("D3", 10, "gpio"),
        pad("CMD", 11, "gpio"),
        pad("5V", null, "power"),
      ],
      right: [
        pad("GND", null, "gnd"),
        pad("23", 23, "gpio"),
        pad("22", 22, "gpio"),
        pad("TXD", 1, "gpio"),
        pad("RXD", 3, "gpio"),
        pad("21", 21, "gpio"),
        pad("GND", null, "gnd"),
        pad("19", 19, "gpio"),
        pad("18", 18, "gpio"),
        pad("5", 5, "gpio"),
        pad("17", 17, "gpio"),
        pad("16", 16, "gpio"),
        pad("4", 4, "gpio"),
        pad("0", 0, "gpio"),
        pad("2", 2, "gpio"),
        pad("15", 15, "gpio"),
        pad("D1", 8, "gpio"),
        pad("D0", 7, "gpio"),
        pad("CLK", 6, "gpio"),
      ],
    },
    pins: [
      pin(0, { ...io, strap: true, touch: true, adc2: true, boot_btn: true, adc_channel: 1, touch_channel: 1, role: "BOOT", notes: "strapping BOOT; held at reset enters download mode" }),
      pin(1, { ...io, role: "TX0", notes: "UART0 TX — serial console, avoid as GPIO" }),
      pin(2, { ...io, strap: true, touch: true, adc2: true, status_led: true, adc_channel: 2, touch_channel: 2, role: "LED", notes: "strapping; onboard LED on most DevKitC boards" }),
      pin(3, { ...io, role: "RX0", notes: "UART0 RX — serial console, avoid as GPIO" }),
      pin(4, { ...io, touch: true, adc2: true, adc_channel: 0, touch_channel: 0, notes: "general I/O" }),
      pin(5, { ...io, strap: true, role: "VSPI SS", notes: "strapping (timing); default VSPI chip-select" }),
      pin(6, { flash: true, role: "CLK", notes: "SPI flash SCK — reserved" }),
      pin(7, { flash: true, role: "D0", notes: "SPI flash SDO — reserved" }),
      pin(8, { flash: true, role: "D1", notes: "SPI flash SDI — reserved" }),
      pin(9, { flash: true, role: "D2", notes: "SPI flash SHD — reserved" }),
      pin(10, { flash: true, role: "D3", notes: "SPI flash SWP — reserved" }),
      pin(11, { flash: true, role: "CMD", notes: "SPI flash SCS — reserved" }),
      pin(12, { ...io, strap: true, touch: true, adc2: true, adc_channel: 5, touch_channel: 5, role: "HSPI MISO", notes: "MTDI strapping; HIGH at reset can select 1.8V flash and prevent boot" }),
      pin(13, { ...io, touch: true, adc2: true, adc_channel: 4, touch_channel: 4, role: "HSPI MOSI", notes: "general I/O" }),
      pin(14, { ...io, touch: true, adc2: true, adc_channel: 6, touch_channel: 6, role: "HSPI SCK", notes: "general I/O" }),
      pin(15, { ...io, strap: true, touch: true, adc2: true, adc_channel: 3, touch_channel: 3, role: "HSPI SS", notes: "strapping MTDO" }),
      pin(16, { ...io, role: "U2RXD", notes: "general I/O (U2RXD default)" }),
      pin(17, { ...io, role: "U2TXD", notes: "general I/O (U2TXD default)" }),
      pin(18, { ...io, role: "VSPI SCK", notes: "VSPI SCK default" }),
      pin(19, { ...io, role: "VSPI MISO", notes: "VSPI MISO default" }),
      pin(21, { ...io, role: "I2C SDA", notes: "default I2C SDA" }),
      pin(22, { ...io, role: "I2C SCL", notes: "default I2C SCL" }),
      pin(23, { ...io, role: "VSPI MOSI", notes: "VSPI MOSI default" }),
      pin(25, { ...io, adc2: true, dac: true, adc_channel: 8, role: "DAC1", notes: "DAC1 / ADC2" }),
      pin(26, { ...io, adc2: true, dac: true, adc_channel: 9, role: "DAC2", notes: "DAC2 / ADC2" }),
      pin(27, { ...io, touch: true, adc2: true, adc_channel: 7, touch_channel: 7, notes: "general I/O" }),
      pin(32, { ...io, touch: true, adc1: true, adc_channel: 4, touch_channel: 9, notes: "ADC1_CH4" }),
      pin(33, { ...io, touch: true, adc1: true, adc_channel: 5, touch_channel: 8, notes: "ADC1_CH5" }),
      pin(34, { ...inOnly, adc1: true, adc_channel: 6, notes: "input-only, no internal pull, ADC1_CH6" }),
      pin(35, { ...inOnly, adc1: true, adc_channel: 7, notes: "input-only, no internal pull, ADC1_CH7" }),
      pin(36, { ...inOnly, adc1: true, adc_channel: 0, role: "SVP", notes: "input-only SVP, ADC1_CH0" }),
      pin(37, { ...inOnly, adc1: true, adc_channel: 1, notes: "input-only, ADC1_CH1 (often not routed)" }),
      pin(38, { ...inOnly, adc1: true, adc_channel: 2, notes: "input-only, ADC1_CH2 (often not routed)" }),
      pin(39, { ...inOnly, adc1: true, adc_channel: 3, role: "SVN", notes: "input-only SVN, ADC1_CH3" }),
    ],
  };
}

function withFallbackMeta(err) {
  const hw = snapshot();
  hw.via = "devkitc-fallback";
  hw.warning = String((err && err.message) || err || "device HTTP failed");
  return hw;
}

module.exports = { snapshot, withFallbackMeta };
