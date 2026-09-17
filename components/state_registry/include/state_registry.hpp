#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t state_registry_init();
esp_err_t state_set(const char* key, cJSON* value);  // copies
esp_err_t state_clear(const char* key);
cJSON* state_get_clone(const char* key);             // caller cJSON_Delete
cJSON* state_snapshot();                             // object of all keys, caller deletes

}  // namespace runtime
