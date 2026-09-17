#include "io_gpio.hpp"

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "capability_manager.hpp"
#include "driver/gpio.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_gpio";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;

struct GpioSlot {
    bool used;
    bool output;
    bool invert;
    bool irq;
    int last;
    int debounce_ms;
    TickType_t debounce_until;
};

GpioSlot s_slots[kMaxGpio];
QueueHandle_t s_irq_q;
bool s_isr_service;

void publish_gpio(int gpio, int level) {
    char key[16];
    snprintf(key, sizeof(key), "gpio_%d", gpio);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", s_slots[gpio].output ? "out" : "in");
    cJSON_AddNumberToObject(st, "gpio", gpio);
    cJSON_AddNumberToObject(st, "level", level);
    if (!s_slots[gpio].output) {
        cJSON_AddNumberToObject(st, "debounce_ms", s_slots[gpio].debounce_ms);
    }
    state_set(key, st);
    event_bus_publish("io/gpio", st);
    cJSON_Delete(st);
}

void IRAM_ATTR isr_handler(void* arg) {
    int gpio = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    BaseType_t woken = pdFALSE;
    if (s_irq_q) {
        xQueueSendFromISR(s_irq_q, &gpio, &woken);
    }
    if (woken) {
        portYIELD_FROM_ISR();
    }
}

void irq_task(void*) {
    int gpio = 0;
    while (xQueueReceive(s_irq_q, &gpio, portMAX_DELAY) == pdTRUE) {
        if (gpio < 0 || gpio >= kMaxGpio || !s_slots[gpio].used || !s_slots[gpio].irq) {
            continue;
        }
        TickType_t now = xTaskGetTickCount();
        const int db = s_slots[gpio].debounce_ms;
        if (db > 0) {
            if (now < s_slots[gpio].debounce_until) {
                continue;
            }
            s_slots[gpio].debounce_until = now + pdMS_TO_TICKS(db);
        }
        int level = io_gpio_get(gpio);
        if (level == s_slots[gpio].last) {
            continue;
        }
        s_slots[gpio].last = level;
        publish_gpio(gpio, level);
    }
}

}  // namespace

esp_err_t io_gpio_init() {
    memset(s_slots, 0, sizeof(s_slots));
    if (!s_irq_q) {
        s_irq_q = xQueueCreate(16, sizeof(int));
    }
    if (!s_isr_service) {
        esp_err_t isr = gpio_install_isr_service(0);
        if (isr != ESP_OK && isr != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "gpio isr service %s", esp_err_to_name(isr));
        }
        s_isr_service = true;
    }
    xTaskCreate(irq_task, "gpio_irq", 3072, nullptr, 10, nullptr);
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

void io_gpio_safe_defaults() {
    // Leave pins floating until configured. Do not drive outputs during boot.
    ESP_LOGI(TAG, "safe defaults: no outputs driven");
}

esp_err_t io_gpio_configure(int gpio, bool output, bool pull_up, bool pull_down, bool invert,
                            int boot_level, bool irq, int debounce_ms, char* err, size_t err_len) {
    const char* mode = output ? "out" : "in";
    if (!capability_allows(gpio, mode, err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    const PinInfo* info = capability_pin(gpio);
    if (output == false && (pull_up || pull_down) && info && (info->flags & PIN_INPUT_ONLY)) {
        if (err && err_len) {
            snprintf(err, err_len, "input-only pins have no internal pull");
        }
        return ESP_ERR_INVALID_ARG;
    }
    char owner[16];
    snprintf(owner, sizeof(owner), "gpio_%d", gpio);
    esp_err_t errc = resource_claim(gpio, owner, err, err_len);
    if (errc != ESP_OK) {
        return errc;
    }

    gpio_config_t io{};
    io.pin_bit_mask = 1ULL << gpio;
    io.mode = output ? GPIO_MODE_INPUT_OUTPUT : GPIO_MODE_INPUT;
    io.pull_up_en = pull_up ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE;
    io.pull_down_en = pull_down ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE;
    io.intr_type = irq ? GPIO_INTR_ANYEDGE : GPIO_INTR_DISABLE;
    errc = gpio_config(&io);
    if (errc != ESP_OK) {
        resource_release(gpio, owner);
        return errc;
    }

    if (s_slots[gpio].irq) {
        gpio_isr_handler_remove(static_cast<gpio_num_t>(gpio));
    }

    if (debounce_ms < 0) {
        debounce_ms = 0;
    }
    if (debounce_ms > 500) {
        debounce_ms = 500;
    }
    s_slots[gpio].used = true;
    s_slots[gpio].output = output;
    s_slots[gpio].invert = invert;
    s_slots[gpio].irq = irq && !output;
    s_slots[gpio].debounce_ms = output ? 0 : debounce_ms;

    if (output) {
        int physical = invert ? (boot_level ? 0 : 1) : (boot_level ? 1 : 0);
        gpio_set_level(static_cast<gpio_num_t>(gpio), physical);
        s_slots[gpio].last = boot_level ? 1 : 0;
    } else {
        s_slots[gpio].last = io_gpio_get(gpio);
        if (s_slots[gpio].irq) {
            gpio_isr_handler_add(static_cast<gpio_num_t>(gpio), isr_handler,
                                 reinterpret_cast<void*>(static_cast<intptr_t>(gpio)));
        }
    }
    publish_gpio(gpio, s_slots[gpio].last);
    return ESP_OK;
}

esp_err_t io_gpio_set(int gpio, int level) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_slots[gpio].used || !s_slots[gpio].output) {
        return ESP_ERR_INVALID_STATE;
    }
    int physical = s_slots[gpio].invert ? (level ? 0 : 1) : (level ? 1 : 0);
    gpio_set_level(static_cast<gpio_num_t>(gpio), physical);
    s_slots[gpio].last = level ? 1 : 0;
    publish_gpio(gpio, s_slots[gpio].last);
    return ESP_OK;
}

int io_gpio_get(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return -1;
    }
    int physical = gpio_get_level(static_cast<gpio_num_t>(gpio));
    if (s_slots[gpio].used && s_slots[gpio].invert) {
        return physical ? 0 : 1;
    }
    return physical;
}

esp_err_t io_gpio_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_slots[gpio].used) {
        return ESP_OK;
    }
    if (s_slots[gpio].irq) {
        gpio_isr_handler_remove(static_cast<gpio_num_t>(gpio));
    }
    gpio_reset_pin(static_cast<gpio_num_t>(gpio));
    s_slots[gpio] = {};
    char owner[16];
    snprintf(owner, sizeof(owner), "gpio_%d", gpio);
    resource_release(gpio, owner);
    return ESP_OK;
}

cJSON* io_gpio_state(int gpio) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "gpio", gpio);
    cJSON_AddBoolToObject(o, "used", s_slots[gpio].used);
    if (s_slots[gpio].used) {
        cJSON_AddStringToObject(o, "mode", s_slots[gpio].output ? "out" : "in");
        cJSON_AddNumberToObject(o, "level", io_gpio_get(gpio));
        cJSON_AddBoolToObject(o, "invert", s_slots[gpio].invert);
        cJSON_AddBoolToObject(o, "irq", s_slots[gpio].irq);
        if (!s_slots[gpio].output) {
            cJSON_AddNumberToObject(o, "debounce_ms", s_slots[gpio].debounce_ms);
        }
    }
    return o;
}

}  // namespace runtime
