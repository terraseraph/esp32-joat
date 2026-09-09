#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t command_router_init();
/** Dispatch a command object. Returns a heap JSON object the caller must cJSON_Delete. */
cJSON* command_dispatch(cJSON* req);
esp_err_t command_apply_saved_io(bool skip_if_safe_mode);
/** Array of {cmd, summary, example}. Caller deletes. Keep in sync with command_dispatch. */
cJSON* command_catalog();

}  // namespace runtime
