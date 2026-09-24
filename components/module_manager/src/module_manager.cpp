#include "module_manager.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "capability_manager.hpp"
#include "config_manager.hpp"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "json_util.hpp"
#include "memory_budget.hpp"
#include "state_registry.hpp"

static const char* TAG = "modules";

namespace runtime {
namespace {

constexpr int kMaxTypes = 16;
constexpr size_t kBlob = 2048;

const ModuleTypeOps* s_types[kMaxTypes];
int s_ntypes;
SemaphoreHandle_t s_mu;

cJSON* empty_root() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON_AddItemToObject(root, "modules", cJSON_CreateArray());
    return root;
}

cJSON* load_root() {
    char buf[kBlob];
    size_t len = sizeof(buf);
    if (config_get_blob("components", "modules", buf, &len) == ESP_OK && len > 0) {
        cJSON* root = cJSON_ParseWithLength(buf, len);
        if (root) {
            cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
            if (!cJSON_IsArray(arr)) {
                cJSON_DeleteItemFromObjectCaseSensitive(root, "modules");
                cJSON_AddItemToObject(root, "modules", cJSON_CreateArray());
            }
            return root;
        }
    }
    return empty_root();
}

esp_err_t save_root(cJSON* root) {
    char* printed = cJSON_PrintUnformatted(root);
    if (!printed) {
        return ESP_ERR_NO_MEM;
    }
    size_t n = strlen(printed) + 1;
    esp_err_t err = ESP_ERR_NO_MEM;
    if (n > kBlob) {
        ESP_LOGE(TAG, "modules blob %u exceeds %u", (unsigned)n, (unsigned)kBlob);
    } else {
        err = config_set_blob("components", "modules", printed, n);
    }
    cJSON_free(printed);
    return err;
}

const ModuleTypeOps* find_type(const char* type) {
    if (!type) {
        return nullptr;
    }
    for (int i = 0; i < s_ntypes; ++i) {
        if (s_types[i] && strcmp(s_types[i]->type, type) == 0) {
            return s_types[i];
        }
    }
    return nullptr;
}

cJSON* find_instance(cJSON* arr, const char* id, int* idx_out) {
    int idx = 0;
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        if (strcmp(json_str(it, "id", ""), id) == 0) {
            if (idx_out) {
                *idx_out = idx;
            }
            return it;
        }
        idx++;
    }
    return nullptr;
}

int count_type(cJSON* arr, const char* type, const char* except_id) {
    int n = 0;
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        if (strcmp(json_str(it, "type", ""), type) != 0) {
            continue;
        }
        if (except_id && strcmp(json_str(it, "id", ""), except_id) == 0) {
            continue;
        }
        n++;
    }
    return n;
}

bool fail(char* err, size_t err_len, const char* msg) {
    if (err && err_len) {
        snprintf(err, err_len, "%s", msg ? msg : "error");
    }
    return false;
}

bool pin_gpio(cJSON* pins, const char* role, int* out) {
    if (!cJSON_IsObject(pins) || !role) {
        return false;
    }
    cJSON* v = cJSON_GetObjectItemCaseSensitive(pins, role);
    if (!cJSON_IsNumber(v)) {
        return false;
    }
    *out = v->valueint;
    return true;
}

cJSON* spec_setting(cJSON* spec, const char* key) {
    cJSON* settings = cJSON_GetObjectItemCaseSensitive(spec, "settings");
    if (!cJSON_IsObject(settings) || !key) {
        return nullptr;
    }
    return cJSON_GetObjectItemCaseSensitive(settings, key);
}

bool choice_matches(const char* choice, cJSON* item) {
    if (!choice || !item) {
        return false;
    }
    if (cJSON_IsNumber(item)) {
        char buf[16];
        snprintf(buf, sizeof(buf), "%d", item->valueint);
        return strcmp(buf, choice) == 0;
    }
    if (cJSON_IsString(item) && item->valuestring) {
        return strcmp(item->valuestring, choice) == 0;
    }
    return false;
}

bool looks_int(const char* s) {
    if (!s || !s[0]) {
        return false;
    }
    const char* p = s;
    if (*p == '-' || *p == '+') {
        p++;
    }
    if (!*p) {
        return false;
    }
    for (; *p; p++) {
        if (*p < '0' || *p > '9') {
            return false;
        }
    }
    return true;
}

void add_setting_value(cJSON* out, const char* key, const char* raw) {
    if (!out || !key || !raw) {
        return;
    }
    if (looks_int(raw)) {
        cJSON_AddNumberToObject(out, key, atoi(raw));
    } else {
        cJSON_AddStringToObject(out, key, raw);
    }
}

bool apply_settings(cJSON* spec, const ModuleTypeOps* ops, char* err, size_t err_len) {
    if (!ops || ops->setting_count <= 0 || !ops->settings) {
        return true;
    }
    cJSON* out = cJSON_CreateObject();
    for (int i = 0; i < ops->setting_count; ++i) {
        const ModuleSettingDesc& d = ops->settings[i];
        cJSON* item = spec_setting(spec, d.key);
        const char* kind = d.kind ? d.kind : "int";
        if (strcmp(kind, "enum") == 0) {
            const char* picked = nullptr;
            if (item) {
                for (int c = 0; c < d.choice_count; ++c) {
                    if (choice_matches(d.choices[c].value, item)) {
                        picked = d.choices[c].value;
                        break;
                    }
                }
                if (!picked) {
                    cJSON_Delete(out);
                    char buf[80];
                    snprintf(buf, sizeof(buf), "settings.%s invalid", d.key);
                    return fail(err, err_len, buf);
                }
            } else {
                picked = d.def;
            }
            add_setting_value(out, d.key, picked);
            continue;
        }
        int v = d.def ? atoi(d.def) : 0;
        if (cJSON_IsNumber(item)) {
            v = item->valueint;
        } else if (cJSON_IsString(item) && item->valuestring && looks_int(item->valuestring)) {
            v = atoi(item->valuestring);
        } else if (item) {
            cJSON_Delete(out);
            char buf[80];
            snprintf(buf, sizeof(buf), "settings.%s must be a number", d.key);
            return fail(err, err_len, buf);
        }
        if (v < d.min || v > d.max) {
            cJSON_Delete(out);
            char buf[80];
            snprintf(buf, sizeof(buf), "settings.%s out of range", d.key);
            return fail(err, err_len, buf);
        }
        cJSON_AddNumberToObject(out, d.key, v);
    }
    cJSON_DeleteItemFromObjectCaseSensitive(spec, "settings");
    cJSON_AddItemToObject(spec, "settings", out);
    return true;
}

bool validate_spec(cJSON* spec, cJSON* existing, bool is_add, char* err, size_t err_len) {
    const char* id = json_str(spec, "id", "");
    const char* type = json_str(spec, "type", "");
    if (!module_id_valid(id)) {
        return fail(err, err_len, "id must be [a-z][a-z0-9_]{0,15}");
    }
    const ModuleTypeOps* ops = find_type(type);
    if (!ops) {
        return fail(err, err_len, "unknown module type");
    }
    int dummy = 0;
    cJSON* already = find_instance(existing, id, &dummy);
    if (is_add && already) {
        return fail(err, err_len, "id already in use");
    }
    if (!is_add && !already) {
        return fail(err, err_len, "unknown module id");
    }
    if (count_type(existing, type, is_add ? nullptr : id) >= ops->max_instances) {
        char buf[96];
        snprintf(buf, sizeof(buf), "%s limited to %d instances", type, ops->max_instances);
        return fail(err, err_len, buf);
    }
    // Copy first: json_str points into spec, and the next delete frees it.
    char busbuf[12];
    snprintf(busbuf, sizeof(busbuf), "%s", json_str(spec, "bus", ops->default_bus ? ops->default_bus : "vspi"));
    if (ops->bus_kind && strcmp(ops->bus_kind, "spi") == 0) {
        if (strcmp(busbuf, "vspi") != 0 && strcmp(busbuf, "hspi") != 0) {
            return fail(err, err_len, "bus must be vspi or hspi");
        }
    } else if (ops->bus_kind && strcmp(ops->bus_kind, "i2c") == 0) {
        if (strcmp(busbuf, "i2c0") != 0 && strcmp(busbuf, "i2c1") != 0) {
            return fail(err, err_len, "bus must be i2c0 or i2c1");
        }
    }
    cJSON_DeleteItemFromObjectCaseSensitive(spec, "bus");
    cJSON_AddStringToObject(spec, "bus", busbuf);

    cJSON* pins = cJSON_GetObjectItemCaseSensitive(spec, "pins");
    if (!cJSON_IsObject(pins)) {
        return fail(err, err_len, "pins object required");
    }

    int used[12];
    int nused = 0;
    for (int i = 0; i < ops->pin_count; ++i) {
        const ModulePinRole& role = ops->pins[i];
        int gpio = -1;
        bool have = pin_gpio(pins, role.role, &gpio);
        if (!have) {
            if (role.required) {
                char buf[64];
                snprintf(buf, sizeof(buf), "pin %s required", role.role);
                return fail(err, err_len, buf);
            }
            continue;
        }
        if (!capability_allows(gpio, role.cap, err, err_len)) {
            return false;
        }
        for (int u = 0; u < nused; ++u) {
            if (used[u] == gpio) {
                return fail(err, err_len, "module pins must be unique");
            }
        }
        if (nused < 12) {
            used[nused++] = gpio;
        }
    }

    if (!apply_settings(spec, ops, err, err_len)) {
        return false;
    }
    int addr = json_int(cJSON_GetObjectItemCaseSensitive(spec, "settings"), "addr", -1);

    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, existing) {
        if (strcmp(json_str(it, "id", ""), id) == 0) {
            continue;
        }
        const ModuleTypeOps* other = find_type(json_str(it, "type", ""));
        if (!other || !ops->bus_kind || !other->bus_kind ||
            strcmp(other->bus_kind, ops->bus_kind) != 0) {
            continue;
        }
        if (strcmp(json_str(it, "bus", ""), busbuf) != 0) {
            continue;
        }
        cJSON* op = cJSON_GetObjectItemCaseSensitive(it, "pins");
        for (int i = 0; i < ops->pin_count; ++i) {
            const ModulePinRole& role = ops->pins[i];
            if (!role.share || strcmp(role.share, "bus") != 0) {
                continue;
            }
            int g = -1, og = -1;
            if (!pin_gpio(pins, role.role, &g) || !pin_gpio(op, role.role, &og)) {
                continue;
            }
            if (g != og) {
                char buf[64];
                snprintf(buf, sizeof(buf), "shared %s bus pins must match", ops->bus_kind);
                return fail(err, err_len, buf);
            }
        }
        if (strcmp(ops->bus_kind, "spi") == 0) {
            int cs = -1, ocs = -1;
            pin_gpio(pins, "cs", &cs);
            pin_gpio(op, "cs", &ocs);
            if (cs >= 0 && ocs >= 0 && cs == ocs) {
                return fail(err, err_len, "cs must be unique per reader");
            }
        }
        if (strcmp(ops->bus_kind, "i2c") == 0) {
            int oaddr = json_int(cJSON_GetObjectItemCaseSensitive(it, "settings"), "addr", -1);
            if (addr >= 0 && oaddr >= 0 && addr == oaddr) {
                return fail(err, err_len, "i2c address must be unique on this bus");
            }
        }
    }
    return true;
}

void suggest_id(cJSON* spec, cJSON* existing, const ModuleTypeOps* ops) {
    if (json_str(spec, "id", "")[0]) {
        return;
    }
    const char* prefix = (ops && ops->id_prefix && ops->id_prefix[0]) ? ops->id_prefix : "mod";
    char id[16];
    for (int n = 0; n < 16; ++n) {
        snprintf(id, sizeof(id), "%s%d", prefix, n);
        int dummy = 0;
        if (!find_instance(existing, id, &dummy)) {
            cJSON_DeleteItemFromObjectCaseSensitive(spec, "id");
            cJSON_AddStringToObject(spec, "id", id);
            return;
        }
    }
}

cJSON* normalize_copy(cJSON* spec, const ModuleTypeOps* ops) {
    cJSON* copy = cJSON_CreateObject();
    cJSON_AddStringToObject(copy, "id", json_str(spec, "id", ""));
    cJSON_AddStringToObject(copy, "type", ops->type);
    cJSON_AddStringToObject(copy, "bus", json_str(spec, "bus", ops->default_bus));
    cJSON_AddBoolToObject(copy, "enabled", json_bool(spec, "enabled", true));
    cJSON* pins_in = cJSON_GetObjectItemCaseSensitive(spec, "pins");
    cJSON* pins = cJSON_AddObjectToObject(copy, "pins");
    for (int i = 0; i < ops->pin_count; ++i) {
        int gpio = -1;
        if (pin_gpio(pins_in, ops->pins[i].role, &gpio) && gpio >= 0) {
            cJSON_AddNumberToObject(pins, ops->pins[i].role, gpio);
        }
    }
    cJSON* settings = cJSON_GetObjectItemCaseSensitive(spec, "settings");
    if (cJSON_IsObject(settings)) {
        cJSON_AddItemToObject(copy, "settings", cJSON_Duplicate(settings, 1));
    }
    return copy;
}

esp_err_t admit_one(cJSON* inst, char* err, size_t err_len) {
    const ModuleTypeOps* ops = find_type(json_str(inst, "type", ""));
    if (!ops) {
        fail(err, err_len, "unknown module type");
        return ESP_ERR_NOT_FOUND;
    }
    if (!json_bool(inst, "enabled", true)) {
        return ESP_OK;
    }
    size_t bytes = ops->memory_bytes ? ops->memory_bytes(inst) : 0;
    return memory_admit(bytes, 0, err, err_len);
}

esp_err_t apply_one(cJSON* inst, char* err, size_t err_len) {
    const ModuleTypeOps* ops = find_type(json_str(inst, "type", ""));
    if (!ops || !ops->apply) {
        fail(err, err_len, "unknown module type");
        return ESP_ERR_NOT_FOUND;
    }
    if (!json_bool(inst, "enabled", true)) {
        if (ops->teardown) {
            ops->teardown(json_str(inst, "id", ""));
        }
        return ESP_OK;
    }
    return ops->apply(inst, err, err_len);
}

esp_err_t teardown_one(cJSON* inst) {
    const ModuleTypeOps* ops = find_type(json_str(inst, "type", ""));
    if (ops && ops->teardown) {
        return ops->teardown(json_str(inst, "id", ""));
    }
    return ESP_OK;
}

}  // namespace

bool module_id_valid(const char* id) {
    if (!id || id[0] < 'a' || id[0] > 'z') {
        return false;
    }
    size_t n = 1;
    for (; id[n]; ++n) {
        char c = id[n];
        if (n > 15) {
            return false;
        }
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    return n >= 1 && n <= 16;
}

esp_err_t module_manager_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t module_register_type(const ModuleTypeOps* ops) {
    if (!ops || !ops->type || !ops->apply || !ops->teardown) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_ntypes >= kMaxTypes) {
        return ESP_ERR_NO_MEM;
    }
    if (find_type(ops->type)) {
        return ESP_ERR_INVALID_STATE;
    }
    s_types[s_ntypes++] = ops;
    ESP_LOGI(TAG, "type %s", ops->type);
    return ESP_OK;
}

cJSON* module_catalog_json() {
    cJSON* root = cJSON_CreateObject();
    cJSON* types = cJSON_AddArrayToObject(root, "types");
    for (int i = 0; i < s_ntypes; ++i) {
        const ModuleTypeOps* ops = s_types[i];
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "type", ops->type);
        cJSON_AddStringToObject(o, "label", ops->label ? ops->label : ops->type);
        cJSON_AddStringToObject(o, "summary", ops->summary ? ops->summary : "");
        cJSON_AddStringToObject(o, "bus", ops->bus_kind ? ops->bus_kind : "");
        cJSON_AddStringToObject(o, "default_bus", ops->default_bus ? ops->default_bus : "");
        cJSON_AddStringToObject(o, "id_prefix", ops->id_prefix ? ops->id_prefix : "mod");
        cJSON_AddNumberToObject(o, "max_instances", ops->max_instances);
        cJSON* pins = cJSON_AddArrayToObject(o, "pins");
        for (int p = 0; p < ops->pin_count; ++p) {
            cJSON* pr = cJSON_CreateObject();
            cJSON_AddStringToObject(pr, "role", ops->pins[p].role);
            cJSON_AddBoolToObject(pr, "required", ops->pins[p].required);
            cJSON_AddStringToObject(pr, "share", ops->pins[p].share ? ops->pins[p].share : "instance");
            cJSON_AddStringToObject(pr, "cap", ops->pins[p].cap ? ops->pins[p].cap : "out");
            cJSON_AddItemToArray(pins, pr);
        }
        cJSON* settings = cJSON_AddArrayToObject(o, "settings");
        for (int s = 0; s < ops->setting_count; ++s) {
            const ModuleSettingDesc& d = ops->settings[s];
            cJSON* so = cJSON_CreateObject();
            cJSON_AddStringToObject(so, "key", d.key);
            cJSON_AddStringToObject(so, "label", d.label ? d.label : d.key);
            cJSON_AddStringToObject(so, "kind", d.kind ? d.kind : "int");
            cJSON_AddStringToObject(so, "def", d.def ? d.def : "0");
            if (d.kind && strcmp(d.kind, "int") == 0) {
                cJSON_AddNumberToObject(so, "min", d.min);
                cJSON_AddNumberToObject(so, "max", d.max);
            }
            if (d.choices && d.choice_count > 0) {
                cJSON* ch = cJSON_AddArrayToObject(so, "choices");
                for (int c = 0; c < d.choice_count; ++c) {
                    cJSON* co = cJSON_CreateObject();
                    cJSON_AddStringToObject(co, "value", d.choices[c].value);
                    cJSON_AddStringToObject(co, "label",
                                           d.choices[c].label ? d.choices[c].label : d.choices[c].value);
                    cJSON_AddItemToArray(ch, co);
                }
            }
            cJSON_AddItemToArray(settings, so);
        }
        cJSON_AddItemToArray(types, o);
    }
    return root;
}

cJSON* module_list_json() {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    xSemaphoreGive(s_mu);
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        char key[32];
        snprintf(key, sizeof(key), "mod_%s", json_str(it, "id", ""));
        cJSON* live = state_get_clone(key);
        if (live) {
            cJSON_AddItemToObject(it, "state", live);
        }
    }
    return root;
}

esp_err_t module_add(cJSON* spec, char* err, size_t err_len) {
    if (!spec) {
        fail(err, err_len, "spec required");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
    const ModuleTypeOps* ops = find_type(json_str(spec, "type", ""));
    if (!ops) {
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        fail(err, err_len, "unknown module type");
        return ESP_ERR_NOT_FOUND;
    }
    suggest_id(spec, arr, ops);
    if (!validate_spec(spec, arr, true, err, err_len)) {
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* copy = normalize_copy(spec, ops);
    esp_err_t rc = admit_one(copy, err, err_len);
    if (rc != ESP_OK) {
        cJSON_Delete(copy);
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return rc;
    }
    rc = apply_one(copy, err, err_len);
    if (rc != ESP_OK) {
        cJSON_Delete(copy);
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return rc;
    }
    cJSON_AddItemToArray(arr, copy);
    rc = save_root(root);
    cJSON_Delete(root);
    xSemaphoreGive(s_mu);
    if (rc != ESP_OK) {
        teardown_one(spec);
        fail(err, err_len, "failed to persist modules");
    }
    return rc;
}

esp_err_t module_configure(cJSON* spec, char* err, size_t err_len) {
    if (!spec) {
        fail(err, err_len, "spec required");
        return ESP_ERR_INVALID_ARG;
    }
    const char* id = json_str(spec, "id", "");
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
    int idx = 0;
    cJSON* existing = find_instance(arr, id, &idx);
    if (!existing) {
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        fail(err, err_len, "unknown module id");
        return ESP_ERR_NOT_FOUND;
    }
    if (!cJSON_GetObjectItemCaseSensitive(spec, "type")) {
        cJSON_AddStringToObject(spec, "type", json_str(existing, "type", ""));
    }
    if (!cJSON_GetObjectItemCaseSensitive(spec, "bus")) {
        cJSON_AddStringToObject(spec, "bus", json_str(existing, "bus", ""));
    }
    if (!cJSON_GetObjectItemCaseSensitive(spec, "pins")) {
        cJSON* pins = cJSON_GetObjectItemCaseSensitive(existing, "pins");
        if (pins) {
            cJSON_AddItemToObject(spec, "pins", cJSON_Duplicate(pins, 1));
        }
    }
    if (!cJSON_GetObjectItemCaseSensitive(spec, "settings")) {
        cJSON* settings = cJSON_GetObjectItemCaseSensitive(existing, "settings");
        if (settings) {
            cJSON_AddItemToObject(spec, "settings", cJSON_Duplicate(settings, 1));
        }
    }
    const ModuleTypeOps* ops = find_type(json_str(spec, "type", ""));
    if (!ops || !validate_spec(spec, arr, false, err, err_len)) {
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* copy = normalize_copy(spec, ops);
    esp_err_t admitted = admit_one(copy, err, err_len);
    if (admitted != ESP_OK) {
        cJSON_Delete(copy);
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return admitted;
    }
    cJSON* old = cJSON_Duplicate(existing, 1);
    teardown_one(existing);
    esp_err_t rc = apply_one(copy, err, err_len);
    if (rc != ESP_OK) {
        apply_one(old, nullptr, 0);
        cJSON_Delete(copy);
        cJSON_Delete(old);
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        return rc;
    }
    cJSON_ReplaceItemInArray(arr, idx, copy);
    rc = save_root(root);
    cJSON_Delete(old);
    cJSON_Delete(root);
    xSemaphoreGive(s_mu);
    return rc;
}

esp_err_t module_remove(const char* id, char* err, size_t err_len) {
    if (!module_id_valid(id)) {
        fail(err, err_len, "id required");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
    int idx = 0;
    cJSON* existing = find_instance(arr, id, &idx);
    if (!existing) {
        cJSON_Delete(root);
        xSemaphoreGive(s_mu);
        fail(err, err_len, "unknown module id");
        return ESP_ERR_NOT_FOUND;
    }
    teardown_one(existing);
    char key[32];
    snprintf(key, sizeof(key), "mod_%s", id);
    state_clear(key);
    cJSON_DeleteItemFromArray(arr, idx);
    esp_err_t rc = save_root(root);
    cJSON_Delete(root);
    xSemaphoreGive(s_mu);
    return rc;
}

esp_err_t module_cmd(const char* id, cJSON* payload, cJSON** result, char* err, size_t err_len) {
    if (result) {
        *result = nullptr;
    }
    if (!module_id_valid(id)) {
        fail(err, err_len, "id required");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    int dummy = 0;
    cJSON* existing =
        find_instance(cJSON_GetObjectItemCaseSensitive(root, "modules"), id, &dummy);
    const char* type = existing ? json_str(existing, "type", "") : "";
    const ModuleTypeOps* ops = find_type(type);
    cJSON_Delete(root);
    xSemaphoreGive(s_mu);
    if (!ops) {
        fail(err, err_len, "unknown module id");
        return ESP_ERR_NOT_FOUND;
    }
    if (!ops->cmd) {
        fail(err, err_len, "module has no commands");
        return ESP_ERR_NOT_SUPPORTED;
    }
    return ops->cmd(id, payload, result, err, err_len);
}

esp_err_t module_apply_saved() {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON* root = load_root();
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "modules");
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        char err[96];
        err[0] = '\0';
        esp_err_t rc = admit_one(it, err, sizeof(err));
        if (rc != ESP_OK) {
            ESP_LOGW(TAG, "admit %s skipped: %s", json_str(it, "id", "?"), err);
            continue;
        }
        rc = apply_one(it, err, sizeof(err));
        if (rc != ESP_OK) {
            ESP_LOGW(TAG, "apply %s failed: %s", json_str(it, "id", "?"), err);
        }
    }
    cJSON_Delete(root);
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

}  // namespace runtime
