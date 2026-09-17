#include "state_registry.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "state";

namespace runtime {
namespace {

constexpr int kMaxKeys = 48;

struct Slot {
    char key[32];
    cJSON* value;
};

SemaphoreHandle_t s_mu;
Slot s_slots[kMaxKeys];

Slot* find_unlocked(const char* key) {
    for (int i = 0; i < kMaxKeys; ++i) {
        if (s_slots[i].key[0] && strcmp(s_slots[i].key, key) == 0) {
            return &s_slots[i];
        }
    }
    return nullptr;
}

Slot* alloc_unlocked(const char* key) {
    Slot* existing = find_unlocked(key);
    if (existing) {
        return existing;
    }
    for (int i = 0; i < kMaxKeys; ++i) {
        if (!s_slots[i].key[0]) {
            snprintf(s_slots[i].key, sizeof(s_slots[i].key), "%s", key);
            return &s_slots[i];
        }
    }
    return nullptr;
}

}  // namespace

esp_err_t state_registry_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t state_set(const char* key, cJSON* value) {
    if (!key || !value) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* copy = cJSON_Duplicate(value, 1);
    if (!copy) {
        return ESP_ERR_NO_MEM;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Slot* slot = alloc_unlocked(key);
    if (!slot) {
        xSemaphoreGive(s_mu);
        cJSON_Delete(copy);
        return ESP_ERR_NO_MEM;
    }
    if (slot->value) {
        cJSON_Delete(slot->value);
    }
    slot->value = copy;
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t state_clear(const char* key) {
    if (!key) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Slot* slot = find_unlocked(key);
    if (slot) {
        if (slot->value) {
            cJSON_Delete(slot->value);
            slot->value = nullptr;
        }
        slot->key[0] = '\0';
    }
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

cJSON* state_get_clone(const char* key) {
    if (!key) {
        return nullptr;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Slot* slot = find_unlocked(key);
    cJSON* copy = (slot && slot->value) ? cJSON_Duplicate(slot->value, 1) : nullptr;
    xSemaphoreGive(s_mu);
    return copy;
}

cJSON* state_snapshot() {
    cJSON* root = cJSON_CreateObject();
    if (!root) {
        return nullptr;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < kMaxKeys; ++i) {
        if (s_slots[i].key[0] && s_slots[i].value) {
            cJSON_AddItemToObject(root, s_slots[i].key, cJSON_Duplicate(s_slots[i].value, 1));
        }
    }
    xSemaphoreGive(s_mu);
    return root;
}

}  // namespace runtime
