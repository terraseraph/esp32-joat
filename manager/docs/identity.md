# Identity (Manager)

Firmware: [docs/features/identity.md](../../docs/features/identity.md) · Node-RED: [nodered/.../docs/identity.md](../../nodered/node-red-contrib-de-esp32/docs/identity.md)

## What the Manager does with it
- The device `id` (MAC hex) is the registry key everywhere.
- The device page's System tab shows identity and can rename the board.
- Fleet, Discover and Backups show the name and hostname.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Device › System › Identity | Name input | `name` → `identity.set_name {name}` | `maxLength` 31 (`NAME_MAX`). Trimmed. Empty gives "Enter a name."; over 31 gives "Up to 31 characters." Save is enabled only when the value differs from `status.name`. |
| Device › System › Identity | Topic preview | `topic_id` | `topicIdPreview()` mirrors the firmware sanitizer. An empty result falls back to the hostname (see Gaps). |
| Device › System › Identity | Device ID, MAC, Hostname (`<hostname>.local`), MQTT topic id, Chip, Board, Config schema | `id`, `mac`, `hostname`, `topic_id`, `chip_info` (fallback `chip`), `chip`, `schema` + `generation` | Read from `GET v1/status`. |
| Device › System › Identity | Manager label | (none) | Manager-only `label`, max 64 chars, saved with `patchDevice`. Never sent to the device. |
| Fleet card and table | Title, subtitle | `label` or `name` or `hostname` or `id`; then `hostname · host` | `deviceTitle()`, `deviceSubtitle()`. MAC and chip are not shown. |
| Backups › restore plan | "Rename the device to …" | `identity.set_name {name}` | Off by default (`include.name` false). |

## Server side
**Rename**
- The browser calls `POST /api/devices/:id/command`. The server forwards it to the device's `POST /api/v1/command`, or to the device WebSocket when that link is open, because `identity.set_name` is not `HTTP_ONLY`.
- After an ok reply, `applyCommandEffects` (`api/deviceCall.ts`) writes `registry.update(id, {name: result.name ?? body.name})`.

**Event `identity/rename`** (`device/link.ts`)
- While a device socket is open, the server sets the registry name from `data.name` and forwards the event to browsers as `{t:"event", id, topic, data}`.
- `old_topic_id` and `topic_id` are ignored.

**Health poll** (`device/health.ts`): every successful `/status` poll sets `name: status.name || status.hostname` and `hostname: status.hostname`.

**Registry** (`store/registry.ts`, `<dataDir>/registry.json`)

| Field | Firmware source |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `hostname` | `hostname` |
| `host` | IP or host the Manager reaches it on |

- The registry also keeps `label`, `notes`, `addedAt`, `addedVia`, `lastSeen`, `last` and `pinShadow`.
- It does not store `topic_id`, `mac` or `chip`.

**Discovery**
- It keys results by `status.id`, which must match `/^[0-9a-f]{12}$/i`.
- It reads `name`, `hostname` and `topic_id` from `/status`. The mDNS TXT `name` is used only as a fallback.

**Backups** (`backups/snapshot.ts`, `planner.ts`)
- A snapshot stores `name` (from `status.name`, max 80 in the schema) and `source.id`.
- A restore with `include.name` sends `identity.set_name {name}` last.

## Fake device
`server/fake/state.ts`, `server/fake/commands.ts` (`handleSetName`):

| Field | How the fake builds it |
|---|---|
| `id` | 12 random hex chars, or `FakeDeviceOptions.id` |
| `hostname` | `esp32-` + `id.slice(6)` |
| `mac` | `macFromId(id)` |
| `name` | option value, else the hostname |
| `topic_id` | `topicIdFor(name, hostname)` |
| `ap_ssid` | the hostname |

`identity.set_name` in the fake:
- An empty or missing name becomes the hostname.
- Over 31 chars fails with `name too long (max 31 chars)`.
- It emits `identity/rename {old_topic_id, topic_id, name}`, returns `{name, topic_id, id}` and bumps `generation`.

When the firmware rename changes, update `handleSetName`, `topicIdFor` and `web/src/routes/device/system/helpers.ts` (`topicIdPreview`, `NAME_MAX`) together.

## Code
- `web/src/routes/device/system/IdentityCard.tsx`, `helpers.ts`, `SystemTab.tsx`
- `web/src/lib/format.ts` (`deviceTitle`, `deviceSubtitle`)
- `server/src/api/deviceCall.ts`, `server/src/device/link.ts`, `server/src/device/health.ts`, `server/src/store/registry.ts`
- `server/src/types/device-api.ts`: `IdentitySetNameCommand`, `IdentitySetNameResult`, `DeviceStatus`, `SerialHelloResult`
- `server/fake/state.ts`, `server/fake/commands.ts`

## Gaps
**The `topic_id` fallback is wrong in the fake and the preview.**
- Firmware: an empty name, or one with no valid chars, gives `topic_id` = `id` (the MAC), and an unnamed board has `topic_id` = `id`.
- `topicIdFor` (fake) and `topicIdPreview` (UI) fall back to the hostname instead.
- So an unnamed or factory-reset fake device reports `topic_id` = `esp32-xxxxxx`, where real hardware reports `aabbccddeeff`.

**Over-long names.**
- The firmware truncates names over 31 chars without an error. The fake returns an error.
- A backup `name` may be up to 80 chars, so a restore that includes the name behaves differently on the fake and on real hardware.

**Empty name.**
- Firmware `""` clears the name. The UI blocks it, so a name cannot be reset to the default.
- Firmware with the `name` field missing stores the literal hostname. The fake treats missing and `""` the same.

**`serial.hello` result.** `SerialHelloResult` types `hostname`, but the firmware sends `host` (plus `v` and `heap`). Nothing reads it yet.

**Rename warning text.** The UI says a rename changes "its mDNS name". In fact only the mDNS instance name and TXT `name` change; `<hostname>.local` stays MAC-derived.

**`topic_id` is not tracked.** The registry ignores the `topic_id` from `identity/rename`, and the WebSocket event is handled only while someone has the device open.
