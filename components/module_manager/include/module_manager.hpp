#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

struct ModulePinRole {
    const char* role;
    bool required;
    const char* share;  // "bus" | "instance"
    const char* cap;    // "in" | "out"
};

struct ModuleSettingChoice {
    const char* value;
    const char* label;
};

struct ModuleSettingDesc {
    const char* key;
    const char* label;
    const char* kind;  // "int" | "enum"
    const char* def;
    int min;
    int max;
    const ModuleSettingChoice* choices;
    int choice_count;
};

struct ModuleTypeOps {
    const char* type;
    const char* label;
    const char* summary;
    const char* bus_kind;     // "spi" | "i2c"
    const char* default_bus;  // "vspi" | "i2c0"
    const char* id_prefix;    // "rfid" | "env"
    int max_instances;
    const ModulePinRole* pins;
    int pin_count;
    esp_err_t (*apply)(cJSON* instance, char* err, size_t err_len);
    esp_err_t (*teardown)(const char* id);
    esp_err_t (*cmd)(const char* id, cJSON* payload, cJSON** result, char* err, size_t err_len);
    const ModuleSettingDesc* settings;
    int setting_count;
    /** Bytes this instance will take. Null means no declared cost (still refused when pressure is critical). */
    size_t (*memory_bytes)(const cJSON* spec);
};

esp_err_t module_manager_init();
esp_err_t module_register_type(const ModuleTypeOps* ops);

/** {types:[{type,label,...}]} caller deletes. */
cJSON* module_catalog_json();
/** {modules:[...]} saved config plus live `state` when present. Caller deletes. */
cJSON* module_list_json();

esp_err_t module_add(cJSON* spec, char* err, size_t err_len);
esp_err_t module_configure(cJSON* spec, char* err, size_t err_len);
esp_err_t module_remove(const char* id, char* err, size_t err_len);
esp_err_t module_cmd(const char* id, cJSON* payload, cJSON** result, char* err, size_t err_len);
esp_err_t module_apply_saved();

bool module_id_valid(const char* id);

}  // namespace runtime
