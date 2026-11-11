# Identity (Node-RED)

Firmware: [docs/features/identity.md](../../../docs/features/identity.md) · Manager: [manager/docs/identity.md](../../../manager/docs/identity.md)

## What Node-RED does with it
The `de-esp32-device` config node stores the board's identity. It uses `topicId` (or `deviceId`) to build the MQTT prefix. Its editor can rename the board with `identity.set_name`.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-device` | `deviceId` | `id` (MAC hex) | Read-only in the editor. Filled from Scan or Probe. |
| `de-esp32-device` | `deviceName` | `name` | `maxlength="31"`. Trimmed before sending. Shown as the node label. |
| `de-esp32-device` | `topicId` | `topic_id` | Read-only. Filled from Scan, Probe or the rename reply. |
| `de-esp32-device` | `mqttRoot` | MQTT root (`mqtt.root`) | Default `devices`. See [mqtt](mqtt.md). |
| `de-esp32-device` | `host`, `port` | STA IP or hostname, port 80 | See [wifi](wifi.md). |
| `de-esp32-device` | `name` | (none) | Node-RED label only. |

- MQTT prefix: `mqttRoot + "/" + (topicId || deviceId)` (`nodes/de-esp32-device.js` `mqttPrefix`).
- This matches the firmware fallback, where an unset name gives `topic_id` = `id`.

## Messages
None. Identity is only used in the editor and to build topics.

## Commands sent / events used
**"Save on device" button** (editor only, not per message):
- Sends `POST de-esp32/command` with `{host, port, cmd:"identity.set_name", name}`.
- The admin route forwards it to the device's `POST /api/v1/command`.
- From the reply it reads `result.name`, `result.topic_id` and `result.id` into `deviceName`, `topicId` and `deviceId`.
- An empty name is refused in the editor ("enter a name").

**Probe**:
- `GET de-esp32/status` → device `GET /api/v1/status`.
- `fingerprint.summarize` reads `id`, `name`, `hostname`, `fw`, `topic_id` (falling back to `mqtt.topic_id`), `mqtt.prefix`, `mqtt.root`, `board`, `boot_state` and `ota.running_partition`.

**Scan**:
- `discover.scan`: mDNS TXT plus `/api/v1/status`, as in [wifi](wifi.md).
- With a broker, it also reads MQTT retained `<root>/+/api` (`id`, `name`, `topic_id`, `fw`, `prefix`, `root`) and `<root>/+/availability`.

**Events**: the `identity/rename` WebSocket event is not handled.

## Code
- `nodes/de-esp32-device.js`: `DeviceNode`, `mqttPrefix`, admin routes `/de-esp32/command`, `/de-esp32/status`, `/de-esp32/scan`.
- `nodes/de-esp32-device.html`: the editor, with the `#de-esp32-rename` handler and `fill()`.
- `lib/fingerprint.js`: `isOurs`, `summarize`.
- `lib/discover.js`: `mergeDevice` (key is `id`, or `topic:<topic_id>`).

## Gaps
- **Renames from elsewhere are not picked up.** A rename from the Manager, the web UI or the flasher leaves `topicId` stale. MQTT-based nodes then listen on the old prefix until the node is edited and redeployed. The firmware event `identity/rename {old_topic_id, topic_id, name}` could drive this, but it is WebSocket-only.
- **`board` is always empty after Probe.** `summarize` reads `status.board`, but `GET /api/v1/status` has no `board` field. The firmware publishes the board only as mDNS TXT `board` and `/api/v1/hardware` `board_id`.
- **Fields not shown**: `mac`, `chip` and `chip_info`.
- **The name cannot be cleared to the default.** An empty name is blocked in the editor.
