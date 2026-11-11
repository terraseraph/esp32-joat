#include "io_delivery.hpp"

#include <cstdio>
#include <cstring>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
constexpr int kMaxModules = 16;

struct ModSlot {
    char id[17];  // module ids are at most 16 chars
    bool reliable;
};

// Written when a pin or module is configured, read on every io event from the producer tasks.
bool s_pin[kMaxGpio];
ModSlot s_mod[kMaxModules];
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

ModSlot* find_mod(const char* id) {
    for (ModSlot& m : s_mod) {
        if (m.id[0] && strcmp(m.id, id) == 0) {
            return &m;
        }
    }
    return nullptr;
}

}  // namespace

bool io_delivery_parse(const char* s, bool fallback, bool* reliable) {
    if (!s || !s[0]) {
        *reliable = fallback;
        return true;
    }
    if (strcmp(s, "reliable") == 0) {
        *reliable = true;
        return true;
    }
    if (strcmp(s, "latest") == 0) {
        *reliable = false;
        return true;
    }
    return false;
}

const char* io_delivery_name(bool reliable) { return reliable ? "reliable" : "latest"; }

void io_delivery_set_pin(int gpio, bool reliable) {
    if (gpio >= 0 && gpio < kMaxGpio) {
        s_pin[gpio] = reliable;
    }
}

void io_delivery_set_module(const char* id, bool reliable) {
    if (!id || !id[0]) {
        return;
    }
    taskENTER_CRITICAL(&s_mux);
    ModSlot* m = find_mod(id);
    if (!m) {
        for (ModSlot& free_slot : s_mod) {
            if (!free_slot.id[0]) {
                m = &free_slot;
                snprintf(m->id, sizeof(m->id), "%s", id);
                break;
            }
        }
    }
    if (m) {
        m->reliable = reliable;
    }
    taskEXIT_CRITICAL(&s_mux);
}

void io_delivery_clear_module(const char* id) {
    if (!id || !id[0]) {
        return;
    }
    taskENTER_CRITICAL(&s_mux);
    ModSlot* m = find_mod(id);
    if (m) {
        m->id[0] = '\0';
        m->reliable = false;
    }
    taskEXIT_CRITICAL(&s_mux);
}

bool io_delivery_reliable(const cJSON* payload) {
    if (!payload) {
        return false;
    }
    const cJSON* gpio = cJSON_GetObjectItemCaseSensitive(payload, "gpio");
    if (cJSON_IsNumber(gpio)) {
        const int g = gpio->valueint;
        return g >= 0 && g < kMaxGpio && s_pin[g];
    }
    const cJSON* id = cJSON_GetObjectItemCaseSensitive(payload, "id");
    if (!cJSON_IsString(id) || !id->valuestring) {
        return false;
    }
    taskENTER_CRITICAL(&s_mux);
    const ModSlot* m = find_mod(id->valuestring);
    const bool reliable = m && m->reliable;
    taskEXIT_CRITICAL(&s_mux);
    return reliable;
}

}  // namespace runtime
