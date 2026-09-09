#include "device_identity.hpp"

#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "nvs.h"
#include "nvs_flash.h"

static const char* TAG = "identity";

namespace runtime {
namespace {

uint8_t s_mac[6];
char s_id[13];
char s_mac_colon[18];
char s_host[16];
char s_chip[24];
char s_chip_model_name[12];
int s_chip_rev;
int s_chip_cores;
uint32_t s_chip_features;
char s_name[32];
char s_topic_id[32];

void rebuild_topic_id() {
    s_topic_id[0] = '\0';
    if (s_name[0]) {
        size_t j = 0;
        for (size_t i = 0; s_name[i] && j + 1 < sizeof(s_topic_id); ++i) {
            const char c = s_name[i];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                c == '_' || c == '-') {
                s_topic_id[j++] = c;
            } else if (c == ' ' || c == '.') {
                s_topic_id[j++] = '_';
            }
        }
        s_topic_id[j] = '\0';
    }
    if (!s_topic_id[0]) {
        snprintf(s_topic_id, sizeof(s_topic_id), "%s", s_id);
    }
}

}  // namespace

esp_err_t identity_init() {
    esp_err_t err = esp_read_mac(s_mac, ESP_MAC_WIFI_STA);
    if (err != ESP_OK) {
        return err;
    }
    snprintf(s_id, sizeof(s_id), "%02x%02x%02x%02x%02x%02x", s_mac[0], s_mac[1], s_mac[2], s_mac[3],
             s_mac[4], s_mac[5]);
    snprintf(s_mac_colon, sizeof(s_mac_colon), "%02x:%02x:%02x:%02x:%02x:%02x", s_mac[0], s_mac[1],
             s_mac[2], s_mac[3], s_mac[4], s_mac[5]);
    snprintf(s_host, sizeof(s_host), "esp32-%02x%02x%02x", s_mac[3], s_mac[4], s_mac[5]);

    esp_chip_info_t info;
    esp_chip_info(&info);
    const char* model = "unknown";
    switch (info.model) {
        case CHIP_ESP32:
            model = "ESP32";
            break;
        default:
            break;
    }
    snprintf(s_chip_model_name, sizeof(s_chip_model_name), "%s", model);
    s_chip_rev = info.revision;
    s_chip_cores = info.cores;
    s_chip_features = info.features;
    snprintf(s_chip, sizeof(s_chip), "%s rev%d", model, info.revision);

    nvs_handle_t h;
    if (nvs_open("system", NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s_name);
        if (nvs_get_str(h, "device_name", s_name, &len) != ESP_OK) {
            s_name[0] = '\0';
        }
        nvs_close(h);
    }
    rebuild_topic_id();
    ESP_LOGI(TAG, "id=%s host=%s chip=%s name=%s topic=%s", s_id, s_host, s_chip,
             s_name[0] ? s_name : "(unset)", s_topic_id);
    return ESP_OK;
}

const char* device_id() { return s_id; }
const char* mac_colon() { return s_mac_colon; }
const char* hostname() { return s_host; }
const char* ap_ssid() { return s_host; }
const char* chip_model() { return s_chip; }

cJSON* chip_info_json() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "model", s_chip_model_name[0] ? s_chip_model_name : "unknown");
    cJSON_AddNumberToObject(o, "revision", s_chip_rev);
    cJSON_AddNumberToObject(o, "cores", s_chip_cores);
    cJSON* feats = cJSON_AddArrayToObject(o, "features");
    if (s_chip_features & CHIP_FEATURE_WIFI_BGN) {
        cJSON_AddItemToArray(feats, cJSON_CreateString("wifi"));
    }
    if (s_chip_features & CHIP_FEATURE_BT) {
        cJSON_AddItemToArray(feats, cJSON_CreateString("bt"));
    }
    if (s_chip_features & CHIP_FEATURE_BLE) {
        cJSON_AddItemToArray(feats, cJSON_CreateString("ble"));
    }
    if (s_chip_features & CHIP_FEATURE_EMB_FLASH) {
        cJSON_AddItemToArray(feats, cJSON_CreateString("emb_flash"));
    }
    if (s_chip_features & CHIP_FEATURE_EMB_PSRAM) {
        cJSON_AddItemToArray(feats, cJSON_CreateString("psram"));
    }
    return o;
}

const char* device_name() { return s_name[0] ? s_name : s_host; }
const char* device_topic_id() { return s_topic_id[0] ? s_topic_id : s_id; }

esp_err_t set_device_name(const char* name) {
    if (!name) {
        return ESP_ERR_INVALID_ARG;
    }
    char old[32];
    snprintf(old, sizeof(old), "%s", device_topic_id());
    snprintf(s_name, sizeof(s_name), "%s", name);
    rebuild_topic_id();
    nvs_handle_t h;
    esp_err_t err = nvs_open("system", NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, "device_name", s_name);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        cJSON* ev = cJSON_CreateObject();
        cJSON_AddStringToObject(ev, "old_topic_id", old);
        cJSON_AddStringToObject(ev, "topic_id", device_topic_id());
        cJSON_AddStringToObject(ev, "name", device_name());
        event_bus_publish("identity/rename", ev);
        cJSON_Delete(ev);
        ESP_LOGI(TAG, "name=%s topic=%s (was %s)", device_name(), device_topic_id(), old);
    }
    return err;
}

}  // namespace runtime
