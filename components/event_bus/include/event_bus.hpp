#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

typedef void (*event_cb_t)(const char* topic, cJSON* payload, void* ctx);

esp_err_t event_bus_init();
esp_err_t event_bus_subscribe(const char* topic_prefix, event_cb_t cb, void* ctx);
esp_err_t event_bus_publish(const char* topic, cJSON* payload);  // does not take ownership

}  // namespace runtime
