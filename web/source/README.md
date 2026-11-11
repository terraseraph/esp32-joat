# On-device UI source

`index.html` is the whole UI: one file, no framework, no external assets, system fonts.
The `/*MOCK*/ ... /*/MOCK*/` block at the top of the script fakes a device so the file can be
opened straight from disk in a desktop browser to review or develop it. The build removes it.

Build and embed:

    node tools/build_web.js      # writes web/dist/index.html and web/dist/index.html.gz
    idf.py build                 # embeds web/dist/index.html.gz, served with Content-Encoding: gzip

Commit `web/dist/*` with source changes: CI does not run Node, it embeds what is checked in.

Rules that keep it cheap on a classic ESP32 (no PSRAM):
- Status/WebSocket updates only patch live text; they never rewrite a form (phones lose focus).
- `hardware`, `module.catalog/list`, `rule.list` load when a tab first needs them, not at boot.
- The API tab renders `/api/v1/openapi.json`; do not hardcode routes or MQTT topics here.
- Output connections on Live come from `status.sinks` (+ `status.mqtt`, `status.network`). Any extra
  object under `sinks` (for example `udp: {on, target, sent}`) gets a card automatically.
- Size budget: keep gzip under 24 KB (now ~21 KB; the old UI was 31 KB and was sent uncompressed). `node tools/measure_ui.js`.
