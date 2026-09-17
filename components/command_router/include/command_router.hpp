#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t command_router_init();
/** Dispatch a command object. Returns a heap JSON object the caller must cJSON_Delete. */
cJSON* command_dispatch(cJSON* req);
esp_err_t command_apply_saved_io(bool skip_if_safe_mode);
/** Republish each pin on the event bus (MQTT/WS/serial hydrate). Returns pin count. */
int io_emit_snapshot();
/** Array of {cmd, summary, example}. Caller deletes. Keep in sync with command_dispatch. */
cJSON* command_catalog();

}  // namespace runtime
