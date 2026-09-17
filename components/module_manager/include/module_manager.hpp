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

struct ModuleTypeOps {
    const char* type;
    const char* label;
    const char* summary;
    const char* bus_kind;     // "spi"
    const char* default_bus;  // "vspi"
    const char* id_prefix;    // "rfid"
    int max_instances;
    const ModulePinRole* pins;
    int pin_count;
    esp_err_t (*apply)(cJSON* instance, char* err, size_t err_len);
    esp_err_t (*teardown)(const char* id);
    esp_err_t (*cmd)(const char* id, cJSON* payload, cJSON** result, char* err, size_t err_len);
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
