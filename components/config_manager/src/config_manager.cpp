#include "config_manager.hpp"

#include <cstring>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "runtime_version.hpp"

static const char* TAG = "config";

namespace runtime {
namespace {

uint32_t s_generation = 1;

esp_err_t open_ns(const char* ns, nvs_open_mode_t mode, nvs_handle_t* out) {
    return nvs_open(ns, mode, out);
}

void bump_generation() {
    s_generation++;
    nvs_handle_t h;
    if (nvs_open("system", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u32(h, "generation", s_generation);
        nvs_commit(h);
        nvs_close(h);
    }
}

}  // namespace

esp_err_t config_init() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs erase and reinit (%s)", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        return err;
    }

    nvs_handle_t h;
    err = nvs_open("system", NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    uint8_t schema = 0;
    if (nvs_get_u8(h, "schema", &schema) != ESP_OK || schema == 0) {
        schema = RUNTIME_CONFIG_SCHEMA;
        nvs_set_u8(h, "schema", schema);
        nvs_commit(h);
        ESP_LOGI(TAG, "initialized config schema %u", schema);
    } else if (schema > RUNTIME_CONFIG_SCHEMA) {
        nvs_close(h);
        ESP_LOGE(TAG, "config schema %u newer than firmware %d", schema, RUNTIME_CONFIG_SCHEMA);
        return ESP_ERR_INVALID_VERSION;
    } else if (schema < RUNTIME_CONFIG_SCHEMA) {
        ESP_LOGW(TAG, "migrating config schema %u -> %d", schema, RUNTIME_CONFIG_SCHEMA);
        nvs_set_u8(h, "schema", static_cast<uint8_t>(RUNTIME_CONFIG_SCHEMA));
        nvs_commit(h);
    }
    nvs_get_u32(h, "generation", &s_generation);
    if (s_generation == 0) {
        s_generation = 1;
    }
    nvs_close(h);
    return ESP_OK;
}

uint32_t config_generation() { return s_generation; }

int config_schema_version() { return RUNTIME_CONFIG_SCHEMA; }

esp_err_t config_get_blob(const char* ns, const char* key, void* out, size_t* inout_len) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_get_blob(h, key, out, inout_len);
    nvs_close(h);
    return err;
}

esp_err_t config_set_blob(const char* ns, const char* key, const void* data, size_t len) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(h, key, data, len);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        bump_generation();
    }
    return err;
}

esp_err_t config_get_str(const char* ns, const char* key, char* out, size_t* inout_len) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_get_str(h, key, out, inout_len);
    nvs_close(h);
    return err;
}

esp_err_t config_set_str(const char* ns, const char* key, const char* value) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, key, value ? value : "");
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        bump_generation();
    }
    return err;
}

esp_err_t config_get_u8(const char* ns, const char* key, uint8_t* out) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_get_u8(h, key, out);
    nvs_close(h);
    return err;
}

esp_err_t config_set_u8(const char* ns, const char* key, uint8_t value) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_u8(h, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        bump_generation();
    }
    return err;
}

esp_err_t config_get_u32(const char* ns, const char* key, uint32_t* out) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_get_u32(h, key, out);
    nvs_close(h);
    return err;
}

esp_err_t config_set_u32(const char* ns, const char* key, uint32_t value) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_u32(h, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        bump_generation();
    }
    return err;
}

esp_err_t config_erase_key(const char* ns, const char* key) {
    nvs_handle_t h;
    esp_err_t err = open_ns(ns, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_erase_key(h, key);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        err = ESP_OK;
    }
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        bump_generation();
    }
    return err;
}

esp_err_t config_factory_reset() {
    static const char* kNamespaces[] = {"network", "mqtt", "io", "components", "ota", "security",
                                        "stats", "system"};
    for (const char* ns : kNamespaces) {
        nvs_handle_t h;
        if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) {
            continue;
        }
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    bump_generation();
    ESP_LOGW(TAG, "factory reset complete (identity unchanged)");
    return ESP_OK;
}

bool config_has_wifi() {
    char ssid[33] = {0};
    size_t len = sizeof(ssid);
    return config_get_str("network", "ssid", ssid, &len) == ESP_OK && ssid[0] != '\0';
}

}  // namespace runtime
