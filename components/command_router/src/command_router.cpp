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
#include "io_rules.hpp"
#include "io_servo.hpp"
#include "json_util.hpp"
#include "module_manager.hpp"
#include "network_manager.hpp"
#include "ota_manager.hpp"
#include "provisioning.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"
#include "state_registry.hpp"

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

int clamp_int(int v, int lo, int hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

void set_num(cJSON* o, const char* key, int v) {
    if (!o || !key) {
        return;
    }
    cJSON_DeleteItemFromObjectCaseSensitive(o, key);
    cJSON_AddNumberToObject(o, key, v);
}

cJSON* apply_one_pin(cJSON* pin, bool persist) {
    int gpio = json_int(pin, "gpio", -1);
    const char* mode = json_str(pin, "mode", "disabled");
    char err[96];
    err[0] = '\0';
    esp_err_t rc = ESP_OK;
    io_gpio_release(gpio);
    io_pwm_release(gpio);
    io_adc_release(gpio);
    io_servo_release(gpio);
    if (strcmp(mode, "disabled") == 0) {
        rc = ESP_OK;
    } else if (strcmp(mode, "out") == 0 || strcmp(mode, "in") == 0) {
        int debounce_ms = 50;
        if (strcmp(mode, "in") == 0) {
            debounce_ms = clamp_int(json_int(pin, "debounce_ms", 50), 0, 500);
            set_num(pin, "debounce_ms", debounce_ms);
        } else {
            cJSON_DeleteItemFromObjectCaseSensitive(pin, "debounce_ms");
        }
        rc = io_gpio_configure(gpio, strcmp(mode, "out") == 0, json_bool(pin, "pull_up", false),
                               json_bool(pin, "pull_down", false), json_bool(pin, "invert", false),
                               json_int(pin, "boot", 0), json_bool(pin, "irq", strcmp(mode, "in") == 0),
                               debounce_ms, err, sizeof(err));
    } else if (strcmp(mode, "pwm") == 0) {
        rc = io_pwm_configure(gpio, json_int(pin, "hz", 1000), json_int(pin, "duty", 0), err,
                              sizeof(err));
    } else if (strcmp(mode, "servo") == 0) {
        int min_us = clamp_int(json_int(pin, "min_us", 500), 500, 1500);
        int max_us = clamp_int(json_int(pin, "max_us", 2500), 1500, 2500);
        if (max_us <= min_us) {
            min_us = 500;
            max_us = 2500;
        }
        int angle = clamp_int(json_int(pin, "angle", 90), 0, 180);
        set_num(pin, "min_us", min_us);
        set_num(pin, "max_us", max_us);
        set_num(pin, "angle", angle);
        rc = io_servo_configure(gpio, angle, min_us, max_us, err, sizeof(err));
    } else if (strcmp(mode, "adc") == 0) {
        int sample_ms = clamp_int(json_int(pin, "sample_ms", 50), 20, 1000);
        int hysteresis_mv = clamp_int(json_int(pin, "hysteresis_mv", 20), 5, 500);
        int smooth = clamp_int(json_int(pin, "smooth", 70), 0, 90);
        set_num(pin, "sample_ms", sample_ms);
        set_num(pin, "hysteresis_mv", hysteresis_mv);
        set_num(pin, "smooth", smooth);
        rc = io_adc_configure(gpio, sample_ms, hysteresis_mv, smooth, err, sizeof(err));
    } else {
        return err_result(pin, "unknown mode");
    }
    if (rc != ESP_OK) {
        return err_result(pin, err[0] ? err : esp_err_to_name(rc));
    }
    if (persist) {
        persist_pin(pin);
    }
    io_rules_on_io_change();
    cJSON* result = cJSON_Duplicate(pin, 1);
    return ok_result(pin, result);
}

}  // namespace

esp_err_t command_router_init() {
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

int io_emit_snapshot() {
    cJSON* snap = state_snapshot();
    if (!snap) {
        return 0;
    }
    int n = 0;
    for (cJSON* it = snap->child; it; it = it->next) {
        if (!it->string) {
            continue;
        }
        const char* topic = nullptr;
        if (strncmp(it->string, "gpio_", 5) == 0) {
            topic = "io/gpio";
        } else if (strncmp(it->string, "pwm_", 4) == 0) {
            topic = "io/pwm";
        } else if (strncmp(it->string, "adc_", 4) == 0) {
            topic = "io/adc";
        } else if (strncmp(it->string, "servo_", 6) == 0) {
            topic = "io/servo";
        } else if (strncmp(it->string, "mod_", 4) == 0) {
            const char* typ = json_str(it, "type", "");
            if (strcmp(typ, "mfrc522") == 0) {
                topic = "io/rfid";
            } else if (strcmp(typ, "bme280") == 0) {
                topic = "io/env";
            }
        }
        if (!topic) {
            continue;
        }
        event_bus_publish(topic, it);
        n++;
    }
    cJSON_Delete(snap);
    return n;
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
    {"pin.set", "Set output, PWM duty (0-1000), or servo angle (0-180)",
     "{\"cmd\":\"pin.set\",\"gpio\":4,\"value\":90,\"mode\":\"servo\"}"},
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
    {"io.hydrate", "Re-emit each pin on the event bus (MQTT/WS/serial)",
     "{\"cmd\":\"io.hydrate\"}"},
    {"serial.hello", "Start UART IO session; returns identity (no pin dump)",
     "{\"cmd\":\"serial.hello\"}"},
    {"serial.bye", "Stop UART IO session", "{\"cmd\":\"serial.bye\"}"},
    {"module.catalog", "Addon types and pin schemas", "{\"cmd\":\"module.catalog\"}"},
    {"module.list", "Configured module instances plus live state", "{\"cmd\":\"module.list\"}"},
    {"module.add", "Validate, apply, and persist a module instance",
     "{\"cmd\":\"module.add\",\"type\":\"bme280\",\"id\":\"env0\",\"bus\":\"i2c0\",\"pins\":{\"sda\":21,\"scl\":22},\"settings\":{\"addr\":118,\"sample_ms\":1000,\"osrs_t\":1,\"osrs_p\":1,\"osrs_h\":1,\"filter\":0,\"mode\":\"normal\"}}"},
    {"module.configure", "Re-apply pins for an existing module id",
     "{\"cmd\":\"module.configure\",\"id\":\"rfid0\",\"pins\":{\"sck\":18,\"miso\":19,\"mosi\":23,\"cs\":15}}"},
    {"module.remove", "Teardown and forget a module instance",
     "{\"cmd\":\"module.remove\",\"id\":\"rfid0\"}"},
    {"module.cmd", "Type-specific command (none for mfrc522)",
     "{\"cmd\":\"module.cmd\",\"id\":\"rfid0\"}"},
    {"rule.set", "Upsert an on-device pin rule (one per source GPIO)",
     "{\"cmd\":\"rule.set\",\"rule\":{\"on\":{\"gpio\":32,\"op\":\"gt\",\"value\":1000},\"then\":{\"gpio\":18,\"value\":1},\"else\":{\"gpio\":18,\"value\":0}}}"},
    {"rule.remove", "Delete a rule by id or source gpio",
     "{\"cmd\":\"rule.remove\",\"gpio\":32}"},
    {"rule.list", "List persisted on-device pin rules", "{\"cmd\":\"rule.list\"}"},
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

esp_err_t command_apply_saved_modules(bool skip_if_safe_mode) {
    if (skip_if_safe_mode && RuntimeStatus::instance().safe_mode()) {
        ESP_LOGW(TAG, "safe mode: skipping module apply");
        return ESP_OK;
    }
    return module_apply_saved();
}

esp_err_t command_apply_saved_rules(bool skip_if_safe_mode) {
    if (skip_if_safe_mode && RuntimeStatus::instance().safe_mode()) {
        ESP_LOGW(TAG, "safe mode: skipping rule apply");
        return ESP_OK;
    }
    return io_rules_apply_saved();
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
        } else if (strcmp(mode, "servo") == 0) {
            rc = io_servo_set(gpio, value);
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
    if (strcmp(cmd, "io.hydrate") == 0) {
        int n = io_emit_snapshot();
        cJSON* result = cJSON_CreateObject();
        cJSON_AddNumberToObject(result, "pins", n);
        return ok_result(req, result);
    }
    if (strcmp(cmd, "serial.hello") == 0) {
        RuntimeStatus::instance().set_live_serial(true);
        cJSON* result = cJSON_CreateObject();
        cJSON_AddNumberToObject(result, "v", 1);
        cJSON_AddStringToObject(result, "id", device_id());
        cJSON_AddStringToObject(result, "name", device_name());
        cJSON_AddStringToObject(result, "topic_id", device_topic_id());
        cJSON_AddStringToObject(result, "host", hostname());
        cJSON_AddStringToObject(result, "fw", RUNTIME_VERSION);
        cJSON_AddNumberToObject(result, "heap", static_cast<double>(esp_get_free_heap_size()));
        return ok_result(req, result);
    }
    if (strcmp(cmd, "serial.bye") == 0) {
        RuntimeStatus::instance().set_live_serial(false);
        cJSON* result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "session", false);
        return ok_result(req, result);
    }
    if (strcmp(cmd, "module.catalog") == 0) {
        return ok_result(req, module_catalog_json());
    }
    if (strcmp(cmd, "module.list") == 0) {
        return ok_result(req, module_list_json());
    }
    if (strcmp(cmd, "module.add") == 0 || strcmp(cmd, "module.configure") == 0) {
        cJSON* spec = cJSON_GetObjectItemCaseSensitive(req, "module");
        if (!cJSON_IsObject(spec)) {
            spec = req;
        }
        char err[96];
        err[0] = '\0';
        esp_err_t rc = (strcmp(cmd, "module.add") == 0) ? module_add(spec, err, sizeof(err))
                                                        : module_configure(spec, err, sizeof(err));
        if (rc != ESP_OK) {
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return ok_result(req, module_list_json());
    }
    if (strcmp(cmd, "module.remove") == 0) {
        char err[96];
        err[0] = '\0';
        esp_err_t rc = module_remove(json_str(req, "id", ""), err, sizeof(err));
        if (rc != ESP_OK) {
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return ok_result(req, module_list_json());
    }
    if (strcmp(cmd, "module.cmd") == 0) {
        char err[96];
        err[0] = '\0';
        cJSON* result = nullptr;
        esp_err_t rc = module_cmd(json_str(req, "id", ""), req, &result, err, sizeof(err));
        if (rc != ESP_OK) {
            cJSON_Delete(result);
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return ok_result(req, result);
    }
    if (strcmp(cmd, "rule.set") == 0) {
        cJSON* spec = cJSON_GetObjectItemCaseSensitive(req, "rule");
        if (!cJSON_IsObject(spec)) {
            spec = req;
        }
        char err[96];
        err[0] = '\0';
        esp_err_t rc = io_rules_set(spec, err, sizeof(err));
        if (rc != ESP_OK) {
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return ok_result(req, io_rules_list_json());
    }
    if (strcmp(cmd, "rule.remove") == 0) {
        char err[96];
        err[0] = '\0';
        esp_err_t rc = io_rules_remove(json_str(req, "id", ""), json_int(req, "gpio", -1), err,
                                       sizeof(err));
        if (rc != ESP_OK) {
            return err_result(req, err[0] ? err : esp_err_to_name(rc));
        }
        return ok_result(req, io_rules_list_json());
    }
    if (strcmp(cmd, "rule.list") == 0) {
        return ok_result(req, io_rules_list_json());
    }
    return err_result(req, "unknown cmd");
}

}  // namespace runtime
