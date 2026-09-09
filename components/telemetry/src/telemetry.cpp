#include "telemetry.hpp"

#include "device_identity.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_manager.hpp"
#include "network_manager.hpp"
#include "ota_manager.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"
#include "state_registry.hpp"

static const char* TAG = "telemetry";

namespace runtime {

cJSON* telemetry_snapshot() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "v", 1);
    cJSON_AddStringToObject(o, "id", device_id());
    cJSON_AddStringToObject(o, "fw", RUNTIME_VERSION);
    cJSON_AddNumberToObject(o, "uptime_s", RuntimeStatus::instance().uptime_s());
    cJSON_AddNumberToObject(o, "boot_count", RuntimeStatus::instance().boot_count());
    cJSON_AddNumberToObject(o, "reset_reason", esp_reset_reason());
    cJSON_AddNumberToObject(o, "heap_free", static_cast<double>(esp_get_free_heap_size()));
    cJSON_AddNumberToObject(o, "heap_min", static_cast<double>(esp_get_minimum_free_heap_size()));
    cJSON_AddStringToObject(o, "boot_state", boot_state_name(RuntimeStatus::instance().boot_state()));
    cJSON_AddBoolToObject(o, "safe_mode", RuntimeStatus::instance().safe_mode());
    cJSON_AddItemToObject(o, "network", network_status_json());
    cJSON_AddItemToObject(o, "mqtt", mqtt_status_json());
    cJSON_AddItemToObject(o, "ota", ota_status_json());
    cJSON* io = state_snapshot();
    cJSON_AddItemToObject(o, "io", io ? io : cJSON_CreateObject());
    return o;
}

static void telemetry_task(void*) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(15000));
        cJSON* snap = telemetry_snapshot();
        mqtt_publish_telemetry(snap);
        event_bus_publish("telemetry", snap);
        cJSON_Delete(snap);
    }
}

esp_err_t telemetry_init() {
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

void telemetry_start_task() {
    xTaskCreate(telemetry_task, "telemetry", 4096, nullptr, 4, nullptr);
}

}  // namespace runtime
