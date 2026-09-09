#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t io_gpio_init();
esp_err_t io_gpio_configure(int gpio, bool output, bool pull_up, bool pull_down, bool invert,
                            int boot_level, bool irq, char* err, size_t err_len);
esp_err_t io_gpio_set(int gpio, int level);
int io_gpio_get(int gpio);
esp_err_t io_gpio_release(int gpio);
cJSON* io_gpio_state(int gpio);
void io_gpio_safe_defaults();

}  // namespace runtime
