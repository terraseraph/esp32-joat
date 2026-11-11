# Identity (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/identity.md) · [Manager](../../manager/docs/identity.md)

## What it does
Gives every board a stable id from its Wi-Fi MAC and a hostname derived from it, plus an optional human name stored in NVS. The name also sets the MQTT topic slug (`topic_id`) and the mDNS instance name.

## How it works on the ESP
- `identity_init()` reads the factory STA MAC with `esp_read_mac(ESP_MAC_WIFI_STA)` on every boot. The MAC is never stored.
- The classic ESP32 has no USB serial number, so the Wi-Fi MAC is the only identity.
- `identity_init()` runs in boot state `identity`, before the event bus and the network. See [dev/boot.md](../dev/boot.md).

| Value | Format | Example | Source |
|---|---|---|---|
| `id` (`device_id()`) | 12 lowercase hex chars, no separators | `aabbccddeeff` | MAC |
| `mac` (`mac_colon()`) | `aa:bb:cc:dd:ee:ff` | | MAC |
| `hostname` (`hostname()`) | `esp32-` + last 3 MAC bytes in hex | `esp32-ddeeff` | MAC |
| `ap_ssid` (`ap_ssid()`) | same as `hostname` | `esp32-ddeeff` | MAC |
| `name` (`device_name()`) | the stored name, or `hostname` when none is set | `kitchen-relay` | NVS |
| `topic_id` (`device_topic_id()`) | the name sanitized; `id` when the result is empty | `kitchen-relay` | derived |
| `chip` (`chip_model()`) | `"<model> rev<n>"` | `ESP32 rev3` | `esp_chip_info` |
| `chip_info` | `{model, revision, cores, features[]}`; features come from `wifi`, `bt`, `ble`, `emb_flash`, `psram` | | `esp_chip_info` |

`topic_id` sanitizing (`rebuild_topic_id`):
- `[A-Za-z0-9_-]` is kept.
- Space and `.` become `_`.
- Everything else is dropped.
- The result is capped at 31 chars.

| Where the name is used | Effect |
|---|---|
| mDNS | Instance name and TXT `name`. The hostname stays MAC-derived; see [wifi](wifi.md). |
| MQTT | Topic prefix `<root>/<topic_id>/…`. The client id uses the MAC. |
| Web UI | Display name. |

Two boards with the same name share MQTT topics. Nothing prevents it.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `name` | string, at most 31 chars (longer input is truncated by `snprintf` into `s_name[32]`) | unset, so `device_name()` returns `hostname` | Not trimmed. Any bytes are accepted; only `topic_id` is sanitized. |

- **Storage**: NVS namespace `system`, key `device_name` (`device_identity.cpp:82-88, 136-145`).
- **When applied**: immediately. The mDNS name and MQTT topics follow through the `identity/rename` event.
- **Factory reset**: erases the `system` namespace, so the name is dropped. The MAC id and hostname do not change.

## Commands
Set the name:
```json
{"cmd":"identity.set_name","name":"kitchen-relay"}
```
```json
{"v":1,"ok":true,"result":{"name":"kitchen-relay","topic_id":"kitchen-relay","id":"aabbccddeeff"}}
```

What happens for each kind of `name` value (`command_router.cpp:500-511`):

| `name` sent | Stored name | `name` read back | `topic_id` |
|---|---|---|---|
| `""` | cleared | `hostname` | `id` (the MAC) |
| field missing | the literal hostname (`json_str(req,"name",hostname())`) | `hostname` | `esp32-xxxxxx` |
| longer than 31 chars | first 31 chars | first 31 chars | sanitized from those 31 chars |

**Errors**: only `esp_err_to_name()` of an NVS failure. There is no length error over JSON.

**UART console**:
- `name [new_name]` sets the name, or prints it when called with no argument. It rejects names over 31 chars with `name too long (max 31)` (`app_main.cpp:205-216`). `tools/flash.ps1` sends `name <devName>`.
- `status` prints `name=… id=… host=… ip=… state=… heap=…`.
- The JSON `serial.hello` reply contains `id`, `name`, `topic_id`, `host`, `fw`, `heap`.

**Browser flasher** (`install/index.html`):
- Sends `identity.set_name` over UART after flashing, before the Wi-Fi step, with reply timeout `NAME_MS` = 5000 ms.
- The name field has `maxlength="31"` and is trimmed. An empty field skips the step.

## Events and state
- **Event bus**: `identity/rename` with `{old_topic_id, topic_id, name}`, published after the NVS commit.
- **Who acts on `identity/rename`**:
  - `network_manager` updates the mDNS instance name and TXT `name` on both services.
  - `mqtt_manager` retires the retained `availability`, `status` and `api` topics under the old prefix, then reconnects.
- **Where `identity/rename` is delivered**: WebSocket `/api/v1/ws` as `{"topic":"identity/rename","data":{…}}`. Not over MQTT or UART.
- **`GET /api/v1/status`**: `id`, `name`, `topic_id`, `hostname`, `mac`, `chip`, `chip_info`, `ap_ssid` (`web_server.cpp:127-136`).
- **`GET /api/v1/hardware`**: `chip`, `chip_info`.
- **MQTT retained `…/status` and `…/api`**: `id`, `name`, `topic_id`, `fw`. `api` also has `prefix`, `root`, `command`, `openapi`, `ui`.
- **mDNS TXT**: `id`, `name` (see [wifi](wifi.md)).

## Code
- `components/device_identity/include/device_identity.hpp`, `src/device_identity.cpp`:
  - `identity_init`, `set_device_name`, `rebuild_topic_id`
  - getters `device_id`, `mac_colon`, `hostname`, `ap_ssid`, `device_name`, `device_topic_id`, `chip_model`, `chip_info_json`
- `components/command_router/src/command_router.cpp`: `identity.set_name` handler.
- `main/app_main.cpp`: `cmd_name`, `cmd_status`.
- `components/network_manager/src/network_manager.cpp`: `network_mdns_refresh_identity`.
- `components/mqtt_manager/src/mqtt_manager.cpp`: `on_reconfigure`, `retire_topics`.
