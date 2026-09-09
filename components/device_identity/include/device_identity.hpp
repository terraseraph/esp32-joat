#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t identity_init();
const char* device_id();      // lowercase hex MAC, no separators
const char* mac_colon();      // aa:bb:cc:dd:ee:ff
const char* hostname();       // esp32-<last6>
const char* ap_ssid();        // same as hostname by default
const char* chip_model();     // "ESP32 rev3"
cJSON* chip_info_json();      // model, revision, cores, features — caller deletes
const char* device_name();    // user-settable, falls back to hostname
/** MQTT topic slug: sanitized name if set, else MAC id. */
const char* device_topic_id();
esp_err_t set_device_name(const char* name);

}  // namespace runtime
