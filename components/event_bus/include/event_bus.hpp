#pragma once

#include <cstddef>

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

typedef void (*event_cb_t)(const char* topic, cJSON* payload, void* ctx);

esp_err_t event_bus_init();
esp_err_t event_bus_subscribe(const char* topic_prefix, event_cb_t cb, void* ctx);
esp_err_t event_bus_publish(const char* topic, cJSON* payload);  // does not take ownership

/**
 * The wire frame {"topic":"<topic>","data":<payload>} for the event being delivered.
 * Printed at most once per publish, on the first call, and shared by every subscriber;
 * event_bus_publish frees it after the last callback. Only valid inside an event_cb_t,
 * called with that callback's own topic and payload; nullptr elsewhere or on OOM.
 * *len (optional) receives strlen of the frame.
 */
const char* event_bus_frame(const char* topic, const cJSON* payload, size_t* len = nullptr);

/**
 * Prints the same frame for the caller to own (free with cJSON_free). *data_off and
 * *data_len (optional) locate the payload JSON inside it, for sinks that send it bare.
 */
char* event_bus_print_frame(const char* topic, const cJSON* payload, size_t* data_off,
                            size_t* data_len);

/**
 * event_bus_publish, but event_bus_frame() hands subscribers `frame` (from
 * event_bus_print_frame for the same topic and payload) instead of printing again.
 * The caller keeps ownership of `frame`.
 */
esp_err_t event_bus_publish_framed(const char* topic, cJSON* payload, const char* frame);

}  // namespace runtime
