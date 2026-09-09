#include "command_router.hpp"

#include <cstdio>
#include <cstring>

#include "capability_manager.hpp"
#include "config_manager.hpp"
#include "device_identity.hpp"
#include "esp_log.h"
#include "esp_system.h"
#include "event_bus.hpp"
#include "io_adc.hpp"
#include "io_gpio.hpp"
#include "io_pwm.hpp"
#include "json_util.hpp"
#include "network_manager.hpp"
#include "ota_manager.hpp"
#include "provisioning.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"

static const char* TAG = "cmd";

namespace runtime {
namespace {

cJSON* ok_result(cJSON* req, cJSON* result) {
    cJSON* r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "v", 1);
    cJSON_AddBoolToObject(r, "ok", true);
    const char* corr = json_str(req, "corr", "");
    if (corr && corr[0]) {
        cJSON_AddStringToObject(r, "corr", corr);
    }
    if (result) {
        cJSON_AddItemToObject(r, "result", result);
    }
    return r;
}

cJSON* err_result(cJSON* req, const char* msg) {
    cJSON* r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "v", 1);
    cJSON_AddBoolToObject(r, "ok", false);
    cJSON_AddStringToObject(r, "error", msg ? msg : "error");
    const char* corr = json_str(req, "corr", "");
    if (corr && corr[0]) {
        cJSON_AddStringToObject(r, "corr", corr);
    }
    return r;
}

esp_err_t persist_pin(cJSON* pin) {
    char buf[2048];
    size_t len = sizeof(buf);
    cJSON* root = nullptr;
    if (config_get_blob("io", "pins", buf, &len) == ESP_OK && len > 0) {
        root = cJSON_ParseWithLength(buf, len);
    }
    if (!root) {
        root = cJSON_CreateObject();
        cJSON_AddNumberToObject(root, "v", 1);
        cJSON_AddItemToObject(root, "pins", cJSON_CreateArray());
    }
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "pins");
    if (!cJSON_IsArray(arr)) {
        arr = cJSON_AddArrayToObject(root, "pins");
    }
    int gpio = json_int(pin, "gpio", -1);
    cJSON* existing = nullptr;
    int idx = 0;
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        if (json_int(it, "gpio", -2) == gpio) {
            existing = it;
            break;
        }
        idx++;
    }
    cJSON* copy = cJSON_Duplicate(pin, 1);
    if (existing) {
        cJSON_ReplaceItemInArray(arr, idx, copy);
    } else {
        cJSON_AddItemToArray(arr, copy);
    }
    char* printed = cJSON_PrintUnformatted(root);
    esp_err_t err = ESP_ERR_NO_MEM;
    if (printed) {
        err = config_set_blob("io", "pins", printed, strlen(printed) + 1);
        cJSON_free(printed);
    }
    cJSON_Delete(root);
    return err;
}

cJSON* apply_one_pin(cJSON* pin, bool persist) {
    int gpio = json_int(pin, "gpio", -1);
    const char* mode = json_str(pin, "mode", "disabled");
    char err[96];
    err[0] = '\0';
    esp_err_t rc = ESP_OK;
    if (strcmp(mode, "disabled") == 0) {
        io_gpio_release(gpio);
        io_pwm_release(gpio);
        io_adc_release(gpio);
    } else if (strcmp(mode, "out") == 0 || strcmp(mode, "in") == 0) {
        io_pwm_release(gpio);
        io_adc_release(gpio);
        rc = io_gpio_configure(gpio, strcmp(mode, "out") == 0, json_bool(pin, "pull_up", false),
                               json_bool(pin, "pull_down", false), json_bool(pin, "invert", false),
                               json_int(pin, "boot", 0), json_bool(pin, "irq", strcmp(mode, "in") == 0),
                               err, sizeof(err));
    } else if (strcmp(mode, "pwm") == 0) {
        io_gpio_release(gpio);
        io_adc_release(gpio);
        rc = io_pwm_configure(gpio, json_int(pin, "hz", 1000), json_int(pin, "duty", 0), err,
                              sizeof(err));
    } else if (strcmp(mode, "adc") == 0) {
        io_gpio_release(gpio);
        io_pwm_release(gpio);
        rc = io_adc_configure(gpio, err, sizeof(err));
    } else {
        return err_result(pin, "unknown mode");
    }
    if (rc != ESP_OK) {
        return err_result(pin, err[0] ? err : esp_err_to_name(rc));
    }
    if (persist) {
        persist_pin(pin);
    }
    cJSON* result = cJSON_Duplicate(pin, 1);
    return ok_result(pin, result);
}

}  // namespace

esp_err_t command_router_init() {
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

namespace {

struct CmdInfo {
    const char* cmd;
    const char* summary;
    const char* example;
};

// Names must match command_dispatch. OpenAPI and the UI read this, not a second list.
const CmdInfo kCmds[] = {
    {"pin.configure", "Validate and persist a GPIO mode",
     "{\"cmd\":\"pin.configure\",\"pin\":{\"gpio\":4,\"mode\":\"out\",\"name\":\"gpio_4\"}}"},
    {"pin.set", "Set a configured output or PWM duty (0-1000)",
     "{\"cmd\":\"pin.set\",\"gpio\":4,\"value\":1000,\"mode\":\"out\"}"},
    {"network.wifi.set", "Test STA then save credentials",
     "{\"cmd\":\"network.wifi.set\",\"ssid\":\"MyNet\",\"password\":\"secret\"}"},
    {"network.wifi.scan", "Scan visible SSIDs", "{\"cmd\":\"network.wifi.scan\"}"},
    {"network.wifi.clear", "Forget saved STA credentials", "{\"cmd\":\"network.wifi.clear\"}"},
    {"network.recovery_ap", "Bring up the recovery SoftAP", "{\"cmd\":\"network.recovery_ap\"}"},
    {"network.ap.set_password", "Blank = open AP; 8-63 chars = WPA2",
     "{\"cmd\":\"network.ap.set_password\",\"password\":\"\"}"},
    {"mqtt.configure", "Broker URI, optional topic root (default devices), reconnect",
     "{\"cmd\":\"mqtt.configure\",\"uri\":\"mqtt://192.168.1.10:1883\",\"root\":\"devices\"}"},
    {"identity.set_name", "Set display name; MQTT topics become devices/{name}/...",
     "{\"cmd\":\"identity.set_name\",\"name\":\"esp_joat_test\"}"},
    {"system.reboot", "Reboot now", "{\"cmd\":\"system.reboot\"}"},
    {"system.factory_reset", "Erase NVS user config and reboot",
     "{\"cmd\":\"system.factory_reset\"}"},
    {"ota.apply", "Pull firmware from URL into the inactive slot",
     "{\"cmd\":\"ota.apply\",\"url\":\"http://192.168.1.10/de_esp32_runtime.bin\"}"},
    {"ota.rollback", "Reboot into the previous OTA slot", "{\"cmd\":\"ota.rollback\"}"},
};

}  // namespace

cJSON* command_catalog() {
    cJSON* arr = cJSON_CreateArray();
    for (const CmdInfo& c : kCmds) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "cmd", c.cmd);
        cJSON_AddStringToObject(o, "summary", c.summary);
        cJSON* ex = cJSON_Parse(c.example);
        if (ex) {
            cJSON_AddItemToObject(o, "example", ex);
        }
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

esp_err_t command_apply_saved_io(bool skip_if_safe_mode) {
    if (skip_if_safe_mode && RuntimeStatus::instance().safe_mode()) {
        ESP_LOGW(TAG, "safe mode: skipping I/O apply");
        return ESP_OK;
    }
    char buf[2048];
    size_t len = sizeof(buf);
    if (config_get_blob("io", "pins", buf, &len) != ESP_OK || len == 0) {
        return ESP_OK;
    }
    cJSON* root = cJSON_ParseWithLength(buf, len);
    if (!root) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "pins");
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        cJSON* res = apply_one_pin(it, false);
        if (res && cJSON_IsFalse(cJSON_GetObjectItem(res, "ok"))) {
            ESP_LOGW(TAG, "pin apply failed: %s", json_str(res, "error", ""));
        }
        cJSON_Delete(res);
    }
    cJSON_Delete(root);
    return ESP_OK;
}

cJSON* command_dispatch(cJSON* req) {
    if (!req) {
        return err_result(nullptr, "empty request");
    }
    const char* cmd = json_str(req, "cmd", "");
    ESP_LOGI(TAG, "cmd=%s", cmd);

    if (strcmp(cmd, "pin.configure") == 0) {
        cJSON* pin = cJSON_GetObjectItemCaseSensitive(req, "pin");
        if (!cJSON_IsObject(pin)) {
            pin = req;
        }
        return apply_one_pin(pin, true);
    }
    if (strcmp(cmd, "pin.set") == 0) {
        int gpio = json_int(req, "gpio", -1);
        int value = json_int(req, "value", 0);
        const char* mode = json_str(req, "mode", "out");
        esp_err_t rc = ESP_ERR_NOT_SUPPORTED;
        if (strcmp(mode, "pwm") == 0) {
            rc = io_pwm_set(gpio, value);
        } else {
            rc = io_gpio_set(gpio, value);
        }
        if (rc != ESP_OK) {
            return err_result(req, esp_err_to_name(rc));
        }
        cJSON* result = cJSON_CreateObject();
        cJSON_AddNumberToObject(result, "gpio", gpio);
        cJSON_AddNumberToObject(result, "value", value);
        return ok_result(req, result);
    }
    if (strcmp(cmd, "network.wifi.set") == 0) {
        const char* ssid = json_str(req, "ssid", "");
        const char* pass = json_str(req, "password", "");
        if (!ssid[0]) {
            return err_result(req, "ssid required");
        }
        provisioning_start_dns();
        esp_err_t rc = network_try_sta(ssid, pass, 20000);
        if (rc != ESP_OK) {
            return err_result(req, "wifi test failed; credentials not saved");
        }
        network_commit_wifi(ssid, pass);
        cJSON* result = network_status_json();
        cJSON_AddStringToObject(result, "mdns", hostname());
        return ok_result(req, result);
    }
    if (strcmp(cmd, "network.wifi.scan") == 0) {
        return ok_result(req, network_scan());
    }
    if (strcmp(cmd, "network.wifi.clear") == 0) {
        network_clear_wifi();
        return ok_result(req, network_status_json());
    }
    if (strcmp(cmd, "network.recovery_ap") == 0) {
        network_enable_recovery_ap();
        return ok_result(req, network_status_json());
    }
    if (strcmp(cmd, "network.ap.set_password") == 0) {
        const char* pass = json_str(req, "password", "");
        esp_err_t rc = network_set_ap_password(pass);
        if (rc == ESP_ERR_INVALID_ARG) {
            return err_result(req, "AP password must be empty (open) or 8-63 characters");
        }
        if (rc != ESP_OK) {
            return err_result(req, esp_err_to_name(rc));
        }
        return ok_result(req, network_status_json());
    }
    if (strcmp(cmd, "mqtt.configure") == 0) {
        const char* uri = json_str(req, "uri", "");
        char existing_uri[128] = {0};
        size_t elen = sizeof(existing_uri);
        config_get_str("mqtt", "uri", existing_uri, &elen);
        if (!uri[0] && !existing_uri[0]) {
            return err_result(req, "uri required (mqtt://host:1883)");
        }
        if (uri[0]) {
            config_set_str("mqtt", "uri", uri);
        }
        cJSON* user_item = cJSON_GetObjectItemCaseSensitive(req, "user");
        if (cJSON_IsString(user_item)) {
            config_set_str("mqtt", "user", json_str(req, "user", ""));
            config_set_str("mqtt", "password", json_str(req, "password", ""));
        }
        char old_root[48] = {0};
        size_t rn = sizeof(old_root);
        if (config_get_str("mqtt", "root", old_root, &rn) != ESP_OK || !old_root[0]) {
            snprintf(old_root, sizeof(old_root), "devices");
        }
        cJSON* root_item = cJSON_GetObjectItemCaseSensitive(req, "root");
        if (cJSON_IsString(root_item) && root_item->valuestring) {
            char next[48];
            const char* in = root_item->valuestring;
            size_t j = 0;
            bool slash = true;
            for (size_t i = 0; in[i] && j + 1 < sizeof(next); ++i) {
                const char c = in[i];
                if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                    c == '_' || c == '-') {
                    next[j++] = c;
                    slash = false;
                } else if (c == '/' && !slash) {
                    next[j++] = '/';
                    slash = true;
                }
            }
            while (j > 0 && next[j - 1] == '/') {
                j--;
            }
            next[j] = '\0';
            if (!next[0]) {
                snprintf(next, sizeof(next), "devices");
            }
            config_set_str("mqtt", "root", next);
        }
        config_set_u8("mqtt", "enabled", 1);
        cJSON_AddStringToObject(req, "old_root", old_root);
        event_bus_publish("mqtt/reconfigure", req);
        cJSON* result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "uri", uri[0] ? uri : existing_uri);
        char shown[48] = {0};
        size_t sn = sizeof(shown);
        if (config_get_str("mqtt", "root", shown, &sn) != ESP_OK || !shown[0]) {
            snprintf(shown, sizeof(shown), "devices");
        }
        cJSON_AddStringToObject(result, "root", shown);
        return ok_result(req, result);
    }
    if (strcmp(cmd, "identity.set_name") == 0) {
        const char* name = json_str(req, "name", hostname());
        esp_err_t rc = set_device_name(name);
        if (rc != ESP_OK) {
            return err_result(req, esp_err_to_name(rc));
        }
        cJSON* result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "name", device_name());
        cJSON_AddStringToObject(result, "topic_id", device_topic_id());
        cJSON_AddStringToObject(result, "id", device_id());
        return ok_result(req, result);
    }
    if (strcmp(cmd, "system.reboot") == 0) {
        cJSON* r = ok_result(req, nullptr);
        esp_restart();
        return r;
    }
    if (strcmp(cmd, "system.factory_reset") == 0) {
        config_factory_reset();
        cJSON* r = ok_result(req, nullptr);
        esp_restart();
        return r;
    }
    if (strcmp(cmd, "ota.apply") == 0) {
        const char* url = json_str(req, "url", "");
        char err[96];
        err[0] = '\0';
        esp_err_t rc = ota_apply_url(url, err, sizeof(err));
        if (rc != ESP_OK) {
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        cJSON* result = ota_status_json();
        cJSON_AddStringToObject(result, "note", "fetching; device reboots when the image is written");
        return ok_result(req, result);
    }
    if (strcmp(cmd, "ota.rollback") == 0) {
        char err[96];
        err[0] = '\0';
        cJSON* r = ok_result(req, nullptr);
        esp_err_t rc = ota_rollback(err, sizeof(err));
        if (rc != ESP_OK) {
            cJSON_Delete(r);
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return r;
    }
    return err_result(req, "unknown cmd");
}

}  // namespace runtime
