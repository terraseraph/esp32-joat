#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t mqtt_init();
esp_err_t mqtt_start();
void mqtt_stop();
bool mqtt_connected();
cJSON* mqtt_status_json();
/** MQTT root segment(s) before the device slug. Default "devices". */
const char* mqtt_topic_root();
/** Array of {topic, suffix, subscribe, publish, retain, summary}. Caller deletes. */
cJSON* mqtt_topics_json();
void mqtt_publish_status();
void mqtt_publish_telemetry(cJSON* payload);

}  // namespace runtime
