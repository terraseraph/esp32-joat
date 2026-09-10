# Source copy of the embedded UI. After editing, run:
#   python tools/sync_web.py
# then rebuild firmware. Keep this file small (classic ESP32, no PSRAM).
#
# Status/WebSocket updates must only refresh live text — never replace form innerHTML
# while the user is typing (phones lose focus and wipe the SSID field).
#
# The Hardware tab draws GET /api/v1/hardware (header + buses + pin flags) and writes
# through pin.configure / pin.set. Do not invent SPI/I2C device drivers in the HTML.
# Live pin values come from WebSocket {topic:"io/…", data} — do not GET /status on
# every I/O event. Close the socket when the tab is hidden so the box stops ADC sampling.
#
# The API tab fetches GET /api/v1/openapi.json and renders it. Do not hardcode routes
# or MQTT topics in the HTML — those come from firmware tables.
