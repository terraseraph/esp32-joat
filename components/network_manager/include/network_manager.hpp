#pragma once

#include <cstdint>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

enum class NetState : uint8_t {
    kIdle = 0,
    kApOnly,
    kStaConnecting,
    kStaConnected,
    kApStaRecovery,
};

esp_err_t network_init();
esp_err_t network_start();
NetState network_state();
const char* network_state_name();
const char* sta_ip();
const char* ap_ip();
int sta_rssi();
bool sta_connected();
esp_err_t network_enable_recovery_ap();
esp_err_t network_set_ap_password(const char* password);
esp_err_t network_try_sta(const char* ssid, const char* password, int timeout_ms);
esp_err_t network_commit_wifi(const char* ssid, const char* password);
esp_err_t network_clear_wifi();
cJSON* network_scan();  // array, caller deletes
cJSON* network_status_json();
void network_start_mdns();
void network_mdns_refresh_identity();
void network_note_sta_lost_for_recovery();

}  // namespace runtime
