# Source copy of the embedded UI. After editing, run:
#   python tools/sync_web.py
# then rebuild firmware. Keep this file small (classic ESP32, no PSRAM).
#
# Status/WebSocket updates must only refresh live text — never replace form innerHTML
# while the user is typing (phones lose focus and wipe the SSID field).
#
# The Hardware tab draws GET /api/v1/hardware (header + buses + pin flags + owner) and writes
# through pin.configure / pin.set. Analog uses ADC mode on ADC1 only; ADC2 is shown
# as A2 but blocked while Wi-Fi is on. Addons (RFID and BME280 from module.catalog, plus hobby
# servo) live in the Addons card: list + Add addon wizard (type → bus/pins → settings → confirm).
# Do not dump catalog pin fields as an always-open form. Do not hardcode RC522 roles —
# instance pin steps walk catalog `pins` (share=bus is filled from the chosen bus).
# Chip knobs come from catalog `settings` on the last wizard step. Servo is still
# `pin.configure` mode servo (not a catalog type); the wizard lists it
# beside modules. While the wizard is picking, pinout clicks assign that role. Pulse
# range is behind <details>. Live pin values come from WebSocket {topic:"io/…", data}
# — do not GET /status on every I/O event. ADC events include mv and raw (12-bit)
# plus sample_ms, hysteresis_mv, and smooth. RFID events are
# {topic:"io/rfid", data:{id,type,present,uid}}; BME280 events are
# {topic:"io/env", data:{id,type,ok,addr,t_c,p_hpa,rh}}. Hardware updates addon live text.
# Overview is visualization only: cards for enabled in/adc (cool), out/pwm/servo (warm),
# and modules. Gauges and indicators update in place from the same WebSocket events.
# Device rename lives on System.
#
# Pins owned by bus_, mod_, or servo_ hide the mode form. The card names the addon and
# the pin role; Remove calls module.remove when one module owns the pin or is the only
# device on that bus. Several modules on one bus are listed and not removed together.
# gpio_ owners stay editable. Filter chips include each module id and each servo.
# Tapping an addon card selects that chip. A conflicted SPI bus still works — the
# wizard names the busy GPIO modes and blocks Next. Narrow screens scroll the
# Configure card into view after a pin tap.
#
# The Configure card hides the GPIO number (the pinout click is the selector). Mode is
# a button group of allowed modes only. Fields appear per mode: in = debounce + pull-up
# (if the pin has one) + invert; out = power-on Low/High + pull-up + invert + Set HIGH/LOW;
# pwm = duty + Hz + Full/Off; servo = angle + live 0/90/180, pulse range collapsed;
# adc = sample / publish threshold / smooth (no drive buttons);
# in / adc also show a Rule block (threshold → another pin). Links draw on the pinout.
# disabled = name + Apply. Close the socket when the tab is hidden so WS is not a live
# sink; MQTT connected, a UART hello session, or an ADC-watching on-device rule can still
# sample ADC.
#
# The System tab Memory card reads status.memory (pressure, internal/dma/psram,
# boot stages, task stack minimums). The header heap pill uses memory.pressure.
# Live updates replace #memmeta only.
#
# The API tab fetches GET /api/v1/openapi.json and renders it. Do not hardcode routes
# or MQTT topics in the HTML — those come from firmware tables.
