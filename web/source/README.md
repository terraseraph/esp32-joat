# Source copy of the embedded UI. After editing, run:
#   python tools/sync_web.py
# then rebuild firmware. Keep this file small (classic ESP32, no PSRAM).
#
# Status/WebSocket updates must only refresh live text — never replace form innerHTML
# while the user is typing (phones lose focus and wipe the SSID field).
#
# The Hardware tab draws GET /api/v1/hardware (header + buses + pin flags + owner) and writes
# through pin.configure / pin.set. Analog uses ADC mode on ADC1 only; ADC2 is shown
# as A2 but blocked while Wi-Fi is on. Addons (RFID from module.catalog, plus hobby
# servo) live in the Addons card: list + Add addon wizard (type → bus/pins → confirm).
# Do not dump catalog pin fields as an always-open form. Do not hardcode RC522 roles —
# instance pin steps walk catalog `pins` (share=bus is filled from the chosen SPI bus).
# Servo is still `pin.configure` mode servo (not a catalog type); the wizard lists it
# beside modules. While the wizard is picking, pinout clicks assign that role. Pulse
# range is behind <details>. Live pin values come from WebSocket {topic:"io/…", data}
# — do not GET /status on every I/O event. ADC events include mv and raw (12-bit)
# plus sample_ms, hysteresis_mv, and smooth. RFID events are
# {topic:"io/rfid", data:{id,type,present,uid}}; update the UID text only.
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
# The API tab fetches GET /api/v1/openapi.json and renders it. Do not hardcode routes
# or MQTT topics in the HTML — those come from firmware tables.
