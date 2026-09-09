#include "json_util.hpp"

#include <cstring>

namespace runtime {

cJSON* json_req_object(cJSON* root, const char* key) {
    if (!root || !key) {
        return nullptr;
    }
    cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsObject(item)) {
        return nullptr;
    }
    return item;
}

const char* json_str(cJSON* obj, const char* key, const char* fallback) {
    if (!obj || !key) {
        return fallback;
    }
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (!cJSON_IsString(item) || !item->valuestring) {
        return fallback;
    }
    return item->valuestring;
}

int json_int(cJSON* obj, const char* key, int fallback) {
    if (!obj || !key) {
        return fallback;
    }
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (!cJSON_IsNumber(item)) {
        return fallback;
    }
    return item->valueint;
}

bool json_bool(cJSON* obj, const char* key, bool fallback) {
    if (!obj || !key) {
        return fallback;
    }
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (!cJSON_IsBool(item)) {
        return fallback;
    }
    return cJSON_IsTrue(item);
}

esp_err_t json_add_str(cJSON* obj, const char* key, const char* value) {
    if (!obj || !key) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!cJSON_AddStringToObject(obj, key, value ? value : "")) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

char* json_print_unformatted(cJSON* obj) {
    return cJSON_PrintUnformatted(obj);
}

}  // namespace runtime
