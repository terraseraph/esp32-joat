# Serial (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/serial.md) · [Manager](../../manager/docs/serial.md)

## What it does
The USB serial port (UART0) is a text console (REPL) and can carry a live io session: after `hello`, every io event is printed as one JSON line (NDJSON). JSON command lines go to the same command router as HTTP, WebSocket and MQTT, so the device can be driven without Wi-Fi.

## How it works on the ESP
- Port `CONFIG_ESP_CONSOLE_UART_NUM` (0, GPIO 1 TX / 3 RX), `CONFIG_ESP_CONSOLE_UART_BAUDRATE` (115200, `sdkconfig.defaults`), 8N1, no flow control. Driver buffers 512 B RX / 512 B TX.
- Tasks: `ser_rx` (stack 6144, prio 5) reads lines; `ser_tx` (stack 3072, prio 4) prints queued io lines.
- Lines end at `\n`; `\r` is ignored; leading/trailing spaces and tabs are trimmed. Max 512 chars; extra chars are dropped.
- A line starting with `{` is parsed as JSON and passed to `command_dispatch`; the reply is printed as one line. Anything else is a REPL command.
- Session = `RuntimeStatus::live_serial`. While on, io events (`io/` bus topics) are copied into a 16-line TX queue; when the queue is full the line is dropped (never blocks the io producer, e.g. the GPIO ISR path).
- The prompt `de-esp32> ` is printed only while no session is on, so session output stays pure NDJSON (IDF log lines still share UART0).
- Idle timeout: 10 min (600000 ms) with no received byte and no queued io line ends the session and prints `{"topic":"session","data":{"state":"timeout"}}`.
- While on, the session counts as a live sink (ADC sampling and touch raw updates keep running).
- There is no cable detection; USB-UART DTR often resets the chip when a monitor opens. The session is a handshake.
- Do not use GPIO 1/3 as pins while the console is in use.

## Settings
None saved. Port and baud come from sdkconfig; the session flag is RAM only and is off after boot.

## Commands
REPL commands (`main/app_main.cpp` `start_console`, `serial_session.cpp` `handle_line`):

| Line | Effect |
|---|---|
| `hello` | runs `serial.hello`: session on, prints identity |
| `bye` | runs `serial.bye`: session off |
| `hydrate` | session on, runs `io.hydrate` (one line per pin/module) |
| `status` | `name=.. id=.. host=.. ip=.. state=.. heap=..` |
| `ota` | OTA status JSON |
| `name [new_name]` | show or set the device name (max 31); prints `name=.. id=.. host=..` (used by `tools/flash.ps1`) |
| `wifi_clear` | forget Wi-Fi, start provisioning DNS |
| `recovery_ap` | enable the recovery SoftAP |
| `reboot`, `factory_reset` | as named |
| `help` | esp_console help |
| other | `unknown command` |

JSON lines (any command of the router, plus):
```json
{"cmd":"serial.hello"}
```
```json
{"v":1,"ok":true,"result":{"v":1,"id":"a0b1c2d3e4f5","name":"..","topic_id":"..","host":"esp32-xxxxxx","fw":"..","heap":123456}}
```
```json
{"cmd":"serial.bye"}
```
```json
{"v":1,"ok":true,"result":{"session":false}}
```
```json
{"cmd":"io.hydrate"}
```
```json
{"v":1,"ok":true,"result":{"pins":5}}
```
`io.hydrate` sent on this UART turns the session on first. A line that is not valid JSON prints `{"v":1,"ok":false,"error":"bad json"}`.

`serial.hello` and `serial.bye` are router commands, so they also work over HTTP, WebSocket and MQTT and switch the UART stream from there.

## Events and state
Session lines are the same frame as WebSocket and MQTT `<root>/<topic_id>/io`:
```json
{"topic":"io/gpio","data":{"id":"gpio_4","mode":"in","gpio":4,"level":1}}
```
- `GET /api/v1/status` `sinks.serial`: bool, session on.
- Timeout line: `{"topic":"session","data":{"state":"timeout"}}` (serial only).

## Code
- `components/serial_session/src/serial_session.cpp`: `serial_session_init`, `serial_session_start`, `rx_task`, `tx_task`, `handle_line`, `on_io`.
- `components/command_router/src/command_router.cpp`: `serial.hello`, `serial.bye`, `io.hydrate`.
- `main/app_main.cpp`: `start_console` and the REPL commands.
- `tools/flash.ps1`: uses `name <new_name>` after flashing.
