#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

cJSON* json_req_object(cJSON* root, const char* key);
const char* json_str(cJSON* obj, const char* key, const char* fallback);
int json_int(cJSON* obj, const char* key, int fallback);
bool json_bool(cJSON* obj, const char* key, bool fallback);

esp_err_t json_add_str(cJSON* obj, const char* key, const char* value);
char* json_print_unformatted(cJSON* obj);  // caller frees with cJSON_free / free

}  // namespace runtime
